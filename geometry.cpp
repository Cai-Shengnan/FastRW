#include "geometry.h"
#include <cmath>

GeometryConfig::GeometryConfig() {
    T_am = 20.0;
    x_size = 2e-2; y_size = 2e-2;
    bottom_thickness = 5e-4 - 2e-5;
    heat_source_thickness = 1e-4;
    top_thickness = 5e-4 - 2e-5;
    virtual_layer_thickness = 2e-5;
    xy_resolution = 1e-4;
    z_resolution = 2e-5;

    nx = static_cast<int>(x_size / xy_resolution);
    ny = static_cast<int>(y_size / xy_resolution);
    nz_bottom = static_cast<int>(bottom_thickness / z_resolution);
    nz_heat = static_cast<int>(heat_source_thickness / z_resolution);
    nz_top = static_cast<int>(top_thickness / z_resolution);
    nz_virtual = static_cast<int>(virtual_layer_thickness / z_resolution);
    nz_total = nz_bottom + 2 * nz_virtual + nz_heat + nz_top;

    z_bottom = {0, nz_bottom - 1};
    z_virtual1 = {z_bottom.second + 1, z_bottom.second + nz_virtual};
    z_heat = {z_virtual1.second + 1, z_virtual1.second + nz_heat};
    z_virtual2 = {z_heat.second + 1, z_heat.second + nz_virtual};
    z_top = {z_virtual2.second + 1, nz_total - 1};

    z_boundary_types["top"] = "Robin";
    z_boundary_types["bottom"] = "Dirichlet";
    z_boundary_params["top"] = 8700;
    z_boundary_params["bottom"] = 343.15;
    lateral_boundary_type = "Neumann";
    lateral_boundary_params = 0;
    boundary_epsilon["Dirichlet"] = 1e-8;
    boundary_epsilon["Neumann"] = 1.22e-7 * 5;
    boundary_epsilon["Robin"] = 1.22e-7 * 5;

    power_density.resize(nz_heat, std::vector<std::vector<double>>(ny+1, std::vector<double>(nx+1,0.0)));

    int patch_size = static_cast<int>(0.005 / xy_resolution);
    double power_density_value = 3.56e10 * xy_resolution * xy_resolution * z_resolution;

    std::vector<int> x_starts = {static_cast<int>(0.25 * nx - patch_size/2.0), static_cast<int>(0.75 * nx - patch_size/2.0)};
    std::vector<int> y_starts = {static_cast<int>(0.25 * ny - patch_size/2.0), static_cast<int>(0.75 * ny - patch_size/2.0)};
    for(int y0 : y_starts){
        for(int x0 : x_starts){
            for(int z=0; z<nz_heat; ++z){
                for(int iy=y0; iy<y0+patch_size && iy<=ny; ++iy){
                    for(int ix=x0; ix<x0+patch_size && ix<=nx; ++ix){
                        power_density[z][iy][ix] = power_density_value;
                    }
                }
            }
        }
    }
}

std::string GeometryConfig::get_region_by_z(int z_index) const {
    if(z_index >= z_bottom.first && z_index <= z_bottom.second) return "bottom";
    if(z_index >= z_virtual1.first && z_index <= z_virtual1.second) return "virtual_bottom";
    if(z_index >= z_heat.first && z_index <= z_heat.second) return "heat_source";
    if(z_index >= z_virtual2.first && z_index <= z_virtual2.second) return "virtual_top";
    if(z_index >= z_top.first && z_index <= z_top.second+1) return "top";
    return "out_of_domain";
}

std::string GeometryConfig::get_region_by_coord(double z_coord) const {
    int z_index = static_cast<int>(std::floor(z_coord / z_resolution));
    return get_region_by_z(z_index);
}

std::tuple<std::string,std::string,double> GeometryConfig::is_near_boundary(const std::array<double,3>& pos) const {
    double z = pos[0];
    if(z >= nz_total * z_resolution - boundary_epsilon.at(z_boundary_types.at("top"))) {
        return {"top", z_boundary_types.at("top"), z_boundary_params.at("top")};
    }
    if(z <= boundary_epsilon.at(z_boundary_types.at("bottom"))) {
        return {"bottom", z_boundary_types.at("bottom"), z_boundary_params.at("bottom")};
    }
    return {"","",0.0};
}

std::unordered_map<std::string,double> GeometryConfig::get_conductance(const std::array<double,3>& pos_meter) const {
    auto get_k=[&](int z_idx){
        std::string region = get_region_by_z(z_idx);
        return (region=="heat_source"?125.0:395.0);
    };

    double z=pos_meter[0];
    double y=pos_meter[1];
    double x=pos_meter[2];
    int ix = static_cast<int>(std::floor(x / xy_resolution));
    int iy = static_cast<int>(std::floor(y / xy_resolution));
    int iz = static_cast<int>(std::floor(z / z_resolution));

    double k_center = get_k(iz);
    double dx = xy_resolution, dy = xy_resolution, dz = z_resolution;
    std::unordered_map<std::string,double> conductance;
    std::array<std::array<int,3>,6> shifts{{{0,0,1},{0,0,-1},{0,1,0},{0,-1,0},{1,0,0},{-1,0,0}}};
    std::array<std::string,6> dirs{{"+x","-x","+y","-y","+z","-z"}};
    for(size_t i=0;i<6;++i){
        int iz_n=iz+shifts[i][0];
        int iy_n=iy+shifts[i][1];
        int ix_n=ix+shifts[i][2];
        bool out_of_bounds = ix_n<0 || ix_n>=nx || iy_n<0 || iy_n>=ny || iz_n<0 || iz_n>=nz_total;
        double A,d;
        if(dirs[i]=="+x" || dirs[i]=="-x"){A=dy*dz; d=dx;} else if(dirs[i]=="+y"||dirs[i]=="-y"){A=dx*dz; d=dy;} else {A=dx*dy; d=dz;}
        double g;
        if(out_of_bounds){
            if(dirs[i]=="+x"||dirs[i]=="-x"||dirs[i]=="+y"||dirs[i]=="-y"){
                double r=(1.0/k_center)*(d/A); g=1.0/r;
            } else {
                g=0.0;
            }
        } else {
            double k_neighbor = get_k(iz_n);
            double r = 0.5*(1.0/k_center + 1.0/k_neighbor)*(d/A);
            g=1.0/r;
        }
        conductance[dirs[i]]=g;
    }
    return conductance;
}
