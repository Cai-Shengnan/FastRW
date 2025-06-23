#include "walker.h"
#include <random>
#include <numeric>
#include <cmath>

RandomWalker::RandomWalker(const GeometryConfig& g): geom(g) {}

double RandomWalker::simulate_temperature(const std::array<double,3>& x0_meter, int N){
    double sum = 0.0;
    for(int i=0;i<N;++i){
        sum += simulate_single_path(x0_meter);
    }
    return sum / N;
}

double RandomWalker::simulate_single_path(const std::array<double,3>& x0_meter){
    std::array<double,3> pos = x0_meter;
    std::array<double,4> T_i{0,0,0,0};
    double e_hat = 1.0;
    int near_robin=0, hit_robin=0; bool in_robin=false; double robin_parameter=0;
    int step_count=0;
    const int max_steps=800000;
    const double eps=5e-4;
    std::default_random_engine gen(std::random_device{}());
    std::normal_distribution<double> normal(0.0,1.0);
    std::uniform_real_distribution<double> unif(0.0,1.0);

    while(step_count < max_steps && e_hat > eps){
        std::string region = geom.get_region_by_coord(pos[0]);
        auto bc = geom.is_near_boundary(pos);
        std::string bc_pos = std::get<0>(bc);
        std::string bc_type = std::get<1>(bc);
        double bc_param = std::get<2>(bc);

        if(bc_pos.empty()){
            if(region=="heat_source"||region=="virtual_top"||region=="virtual_bottom"){
                double reward = region=="heat_source"? get_heat_reward(pos):0.0;
                T_i[0] += e_hat * reward;
                pos = step_wog(pos);
            }else{
                if(in_robin){
                    double dL = estimate_local_time_increment("Robin")*(near_robin/static_cast<double>(std::max(hit_robin,1)));
                    double h = robin_parameter; double k = 395; double c = -h/k; double phi = -c*geom.T_am;
                    for(int i=0;i<hit_robin;i++){
                        e_hat *= std::exp(c*dL);
                        T_i[3] += e_hat*phi*dL;
                    }
                    near_robin=0; hit_robin=0; in_robin=false; robin_parameter=0;
                }
                bool hit=false; pos = step_wos(pos, geom.xy_resolution, hit);
            }
        }else{
            bool is_top = bc_pos=="top";
            bool is_close = is_top? (pos[0] >= (geom.nz_total*geom.z_resolution - geom.virtual_layer_thickness)) : (pos[0] <= geom.virtual_layer_thickness);
            double step_len = is_close? 2*geom.virtual_layer_thickness : geom.virtual_layer_thickness;
            if(bc_type=="Dirichlet"){
                double phi=bc_param; T_i[1]+=e_hat*phi; break; }
            else if(bc_type=="Neumann"){
                double dL=estimate_local_time_increment(bc_type); double phi=bc_param; T_i[2]+=e_hat*phi*dL; bool hit=false; pos=step_wos(pos, step_len, hit);
            }else if(bc_type=="Robin"){
                if(!in_robin){in_robin=true; robin_parameter=bc_param;} near_robin++; bool hit=false; pos=step_wos(pos, step_len, hit); if(hit) hit_robin++; }
        }
        step_count++;
    }
    return T_i[0]+T_i[1]+T_i[2]+T_i[3];
}

std::array<double,3> RandomWalker::step_wos(const std::array<double,3>& pos, double radius, bool& hit){
    std::default_random_engine gen(std::random_device{}());
    std::normal_distribution<double> normal(0.0,1.0);
    std::array<double,3> vec{normal(gen),normal(gen),normal(gen)};
    double norm = std::sqrt(vec[0]*vec[0]+vec[1]*vec[1]+vec[2]*vec[2]);
    for(auto& v:vec) v/=norm;
    std::array<double,3> new_pos{pos[0]+radius*vec[0],pos[1]+radius*vec[1],pos[2]+radius*vec[2]};
    return reflect(new_pos, hit);
}

std::array<double,3> RandomWalker::step_wog(const std::array<double,3>& pos){
    auto g_dict = geom.get_conductance(pos);
    double total_g=0; for(auto&kv:g_dict) total_g+=kv.second;
    std::vector<std::string> keys; keys.reserve(g_dict.size());
    std::vector<double> probs; probs.reserve(g_dict.size());
    for(auto& kv:g_dict){ keys.push_back(kv.first); probs.push_back(kv.second/total_g); }
    std::discrete_distribution<int> dist(probs.begin(), probs.end());
    std::default_random_engine gen(std::random_device{}());
    int idx = dist(gen);
    std::array<double,3> dir{0,0,0};
    if(keys[idx]=="+x") dir={0,0,geom.xy_resolution};
    else if(keys[idx]=="-x") dir={0,0,-geom.xy_resolution};
    else if(keys[idx]=="+y") dir={0,geom.xy_resolution,0};
    else if(keys[idx]=="-y") dir={0,-geom.xy_resolution,0};
    else if(keys[idx]=="+z") dir={geom.z_resolution,0,0};
    else if(keys[idx]=="-z") dir={-geom.z_resolution,0,0};
    std::array<double,3> new_pos{pos[0]+dir[0],pos[1]+dir[1],pos[2]+dir[2]};
    bool hit=false; return reflect(new_pos, hit);
}

std::array<double,3> RandomWalker::reflect(const std::array<double,3>& pos, bool& hit) const {
    double z=pos[0], y=pos[1], x=pos[2];
    double x_max=geom.nx*geom.xy_resolution; double y_max=geom.ny*geom.xy_resolution; double z_max=geom.nz_total*geom.z_resolution;
    if(z<0||z>z_max) hit=true; z=std::min(std::max(z,0.0), z_max);
    x = x<0?-x:x; x = x<x_max?x:2*x_max - x;
    y = y<0?-y:y; y = y<y_max?y:2*y_max - y;
    return {z,y,x};
}

double RandomWalker::get_heat_reward(const std::array<double,3>& pos){
    double z=pos[0], y=pos[1], x=pos[2];
    int iz = static_cast<int>(std::floor(z / geom.z_resolution) - geom.z_heat.first);
    int iy = static_cast<int>(std::floor(y / geom.xy_resolution));
    int ix = static_cast<int>(std::floor(x / geom.xy_resolution));
    if(0<=iz && iz<geom.nz_heat && 0<=iy && iy<=geom.ny && 0<=ix && ix<=geom.nx){
        double gt = get_gt(pos); double p = geom.power_density[iz][iy][ix]; return gt>0? p/gt:0.0; }
    return 0.0;
}

double RandomWalker::get_gt(const std::array<double,3>& pos){
    auto g_dict = geom.get_conductance(pos); double sum=0; for(auto&kv:g_dict) sum+=kv.second; return sum;
}

double RandomWalker::estimate_local_time_increment(const std::string& bc_type){
    double epsilon = geom.boundary_epsilon.at(bc_type); double delta=geom.virtual_layer_thickness; return (delta*delta)/(6*epsilon);
}
