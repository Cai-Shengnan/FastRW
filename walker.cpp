#include "walker.h"
#include <iostream>
#include <random>
#include <thread>
#include <mutex>
#include <numeric>
#include <cmath>
#include <cassert>
#include <atomic>
#include <iomanip>

// Thread-local random number generator (Mersenne Twister) seeded with a random device
static thread_local std::mt19937 rng((std::random_device())());

// RandomWalker constructor
RandomWalker::RandomWalker(GeometryConfig& geometry_config, double max_steps_, double eps_, double delta_x_)
: geom(geometry_config), max_steps(max_steps_), eps(eps_), delta_x(delta_x_) {
    // No additional initialization needed
}

double RandomWalker::simulate_temperature(const Position& x0_meter, int N, int num_workers, int print_interval) {
    if(N <= 0) {
        return 0.0;
    }

    std::vector<double> samples;
    samples.reserve(N);
    long long total_steps = 0;

    int workers = (num_workers <= 0 ? static_cast<int>(std::thread::hardware_concurrency()) : num_workers);
    if(workers < 1) workers = 1;

    // 单线程模式
    if(workers == 1) {
        double sum = 0.0;
        for(int i = 0; i < N; ++i) {
            auto result = simulate_single_path(x0_meter);
            double value = std::get<0>(result);
            int steps = std::get<2>(result);
            sum += value;
            total_steps += steps;
            samples.push_back(value);

            if((i + 1) % print_interval == 0) {
                double current_mean = sum / (i + 1);
                std::cout << "[" << (i + 1) << "/" << N << "] Current Mean: " << std::fixed << std::setprecision(6) << current_mean << std::endl;
            }
        }
    } else {
        // 多线程
        int tasks_per_thread = N / workers;
        int remainder = N % workers;
        std::vector<std::thread> threads;
        std::mutex mutex;
        threads.reserve(workers);

        for(int t = 0; t < workers; ++t) {
            int count = tasks_per_thread + (t < remainder ? 1 : 0);
            threads.emplace_back([&, count]() {
                std::vector<double> local_samples;
                long long local_steps = 0;
                for(int j = 0; j < count; ++j) {
                    auto result = simulate_single_path(x0_meter);
                    double value = std::get<0>(result);
                    int steps = std::get<2>(result);
                    local_samples.push_back(value);
                    local_steps += steps;
                }
                // 合并结果（线程安全）
                std::lock_guard<std::mutex> lock(mutex);
                samples.insert(samples.end(), local_samples.begin(), local_samples.end());
                total_steps += local_steps;
            });
        }

        for(auto& th : threads) {
            if(th.joinable()) th.join();
        }
    }


    // 返回均值
    double total = std::accumulate(samples.begin(), samples.end(), 0.0);
    double mean = total / N;
    double avg_steps = static_cast<double>(total_steps) / N;
    std::cout << "Average steps per path: " << avg_steps << std::endl;
    return mean;
}


std::tuple<double, std::string, int> RandomWalker::simulate_single_path(const Position& x0_meter) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    int near_robin = 0;
    int hit_robin = 0;
    bool in_robin = false;
    double robin_parameter = 0.0;
    int step_count = 0;

    std::string end_boundary;  // will hold "top", "bottom", or empty
    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;


    while(step_count < max_steps) {
        std::string region = geom.get_region_by_coord(pos[0]);
        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);
        if(!isNear) {
            if(region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;
                if(e_hat < 0.1 && region == "heat_source" ){
                    T_i[1] += e_hat * geom.get_temperature_at(pos);
                    break;
                }
                pos = step_wog(pos);
            } else {
                if(in_robin) {
                    auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
                    double sub_T3 = result.first;
                    e_hat = result.second;
                    T_i[3] += sub_T3;
                    near_robin = 0;
                    hit_robin = 0;
                    in_robin = false;
                    robin_parameter = 0.0;
                }
                pos = step_wos(pos).first;
            }
        } else {
            if(bc_type == GeometryConfig::BoundaryType::Dirichlet) {
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                end_boundary = bc_pos;
                break;
            } else {
                bool is_top = (bc_pos == "top");
                bool is_very_close;
                if(is_top) {
                    is_very_close = (pos[0] >= geom.nz_total * geom.z_resolution - delta_x);
                } else {
                    is_very_close = (pos[0] <= delta_x);
                }
                double step_length = is_very_close ? (2 * delta_x) : delta_x;
                if(bc_type == GeometryConfig::BoundaryType::Neumann) {
                    double dL = estimate_local_time_increment(bc_type);
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                    pos = step_wos(pos, step_length).first;
                } else if(bc_type == GeometryConfig::BoundaryType::Robin) {
                    if(!in_robin) {
                        assert(near_robin == 0 && hit_robin == 0);
                        in_robin = true;
                        robin_parameter = bc_param;
                    }
                    if(is_very_close){
                        near_robin += 4;
                    } else{
                        near_robin += 1;
                    }
            
                    bool boundary_hit;
                    std::tie(pos, boundary_hit) = step_wos(pos, step_length);
                    if(boundary_hit) {
                        hit_robin += 1;
                    }
                }
            }
        }
        step_count++;
    }
    if(in_robin) {
        auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
        T_i[3] += result.first;
        e_hat = result.second;
    }
    
    double total_T = T_i[0] + T_i[1] + T_i[2] + T_i[3];

    return { total_T, end_boundary, step_count };
}

// Optionally reseed RNG and call simulate_single_path (for use in parallel loops)
std::tuple<double, std::string, int> RandomWalker::simulate_single_path_wrapper(const Position& x0_meter) {
    rng.seed(std::random_device()());  // new random seed for this execution
    return simulate_single_path(x0_meter);
}

std::pair<double, double> RandomWalker::escape_robin(double e_hat, int hit_robin, int near_robin, double robin_param) {
    double sub_T3 = 0.0;
    double h = robin_param;
    double k = 395.0;
    double c = -h / k;
    double phi = -c * geom.T_am;
    if(hit_robin == 0) {
        // No Robin boundary hits, no contribution
    } else {
        // Average steps per boundary hit in Robin region
        double avg_step_per_hit = (hit_robin > 0) ? (static_cast<double>(near_robin) / hit_robin) : 0.0;
        for(int i = 0; i < hit_robin; ++i) {
            double dL = estimate_local_time_increment(GeometryConfig::BoundaryType::Robin) * avg_step_per_hit;
            e_hat *= std::exp(c * dL);
            sub_T3 += e_hat * phi * dL;
        }
    }
    return { sub_T3, e_hat };
}

double RandomWalker::get_heat_reward(const Position& pos) {
    double z = pos[0];
    double y = pos[1];
    double x = pos[2];
    // Compute indices relative to heat source grid
    int iz = static_cast<int>(std::floor(z / geom.z_resolution)) - geom.z_heat.first;
    int iy = static_cast<int>(std::floor(y / geom.xy_resolution));
    int ix = static_cast<int>(std::floor(x / geom.xy_resolution));
    if(iz >= 0 && iz < geom.nz_heat && iy >= 0 && iy <= geom.ny && ix >= 0 && ix <= geom.nx) {
        // Position is inside the heat source region bounds
        double power = geom.power_density[iz][iy][ix];
        double gt_val = get_gt(pos);
        if(gt_val > 0) {
            return power / gt_val;
        }
    }
    return 0.0;
}

double RandomWalker::get_gt(const Position& pos) {
    std::array<double,6> cond = geom.get_conductance(pos);
    double total = 0.0;
    for(double g : cond) {
        total += g;
    }
    return total;
}

double RandomWalker::estimate_local_time_increment(GeometryConfig::BoundaryType bc_type) {
    // The epsilon (diffusion parameter) for this boundary type
    double epsilon = geom.boundary_epsilon[static_cast<int>(bc_type)];
    double delta = delta_x;
    // Formula: Δt = δ^2 / (6 * epsilon)
    return (delta * delta) / (6.0 * epsilon);
}

std::pair<Position, bool> RandomWalker::step_wos(const Position& pos, double radius) {
    double z = pos[0];
    // Determine current region to choose sphere radius if not provided
    std::string region = geom.get_region_by_coord(z);
    double r;
    if(radius < 0) {
        // No radius given: compute based on distance to nearest region boundary
        if(region == "top") {
            double z_upper = (geom.z_top.second + 1) * geom.z_resolution;
            double dist_to_heat_top = z - (geom.z_heat.second + 1) * geom.z_resolution;
            double dist_to_top_boundary = z_upper - z;
            r = std::min(dist_to_heat_top, dist_to_top_boundary);
        } else {
            // region == "bottom"
            double z_lower = geom.z_bottom.first * geom.z_resolution;
            double dist_to_heat_bottom = geom.z_heat.first * geom.z_resolution - z;
            double dist_to_bottom_boundary = z - z_lower;
            r = std::min(dist_to_heat_bottom, dist_to_bottom_boundary);
        }
    } else {
        // Use the specified radius (for near-boundary steps)
        r = radius;
    }
    // Sample a random direction on the surface of a sphere of radius r
    std::normal_distribution<double> normal_dist(0.0, 1.0);
    double vx = normal_dist(rng);
    double vy = normal_dist(rng);
    double vz = normal_dist(rng);
    // Normalize the vector
    double norm = std::sqrt(vx*vx + vy*vy + vz*vz);
    vx /= norm;
    vy /= norm;
    vz /= norm;
    // Compute new position
    Position new_pos = { pos[0] + r * vz, pos[1] + r * vy, pos[2] + r * vx };
    // Reflect if out of bounds
    bool hit_boundary;
    std::tie(new_pos, hit_boundary) = reflect(new_pos);
    // If landed in a virtual layer, snap to grid center
    std::string new_region = geom.get_region_by_coord(new_pos[0]);
    if(new_region == "virtual_top" || new_region == "virtual_bottom") {
        int z_idx = static_cast<int>(std::floor(new_pos[0] / geom.z_resolution));
        int y_idx = static_cast<int>(std::floor(new_pos[1] / geom.xy_resolution));
        int x_idx = static_cast<int>(std::floor(new_pos[2] / geom.xy_resolution));
        double z_snap = z_idx * geom.z_resolution + geom.z_resolution / 2.0;
        double y_snap = y_idx * geom.xy_resolution + geom.xy_resolution / 2.0;
        double x_snap = x_idx * geom.xy_resolution + geom.xy_resolution / 2.0;
        return { {z_snap, y_snap, x_snap}, hit_boundary };
    }
    return { new_pos, hit_boundary };
}

Position RandomWalker::step_wog(const Position& pos) {
    // Get conductance values in all six directions
    std::array<double, 6> g = geom.get_conductance(pos);
    double total_g = 0.0;
    for(double val : g) total_g += val;
    if(total_g <= 0.0) {
        // No conductance (should not happen in valid domain) – stay at current position
        return pos;
    }
    // Direction vectors for moves: +x, -x, +y, -y, +z, -z
    Position directions[6] = {
        {0.0, 0.0, geom.xy_resolution},   // +x
        {0.0, 0.0, -geom.xy_resolution},  // -x
        {0.0, geom.xy_resolution, 0.0},   // +y
        {0.0, -geom.xy_resolution, 0.0},  // -y
        {geom.z_resolution, 0.0, 0.0},    // +z
        {-geom.z_resolution, 0.0, 0.0}    // -z
    };
    // Choose a direction index according to conductance weights
    std::discrete_distribution<int> dist(g.begin(), g.end());
    int choice = dist(rng);
    Position direction_vector = directions[choice];
    Position new_pos = { pos[0] + direction_vector[0], pos[1] + direction_vector[1], pos[2] + direction_vector[2] };
    // Reflect if the step goes out of lateral bounds (x or y)
    double new_x = new_pos[2];
    double new_y = new_pos[1];
    if(new_x < 0.0 || new_x > geom.x_size || new_y < 0.0 || new_y > geom.y_size) {
        return reflect(new_pos).first;
    }
    return new_pos;
}

std::pair<Position, bool> RandomWalker::reflect(const Position& pos) {
    bool hit_boundary = false;
    double z = pos[0];
    double y = pos[1];
    double x = pos[2];
    double x_max = geom.nx * geom.xy_resolution;
    double y_max = geom.ny * geom.xy_resolution;
    double z_max = geom.nz_total * geom.z_resolution;
    // Reflect z if out of [0, z_max]
    if(z < 0.0 || z > z_max) {
        hit_boundary = true;
    }
    if(z < 0.0) z = 0.0;
    if(z > z_max) z = z_max;
    // Reflect x if out of [0, x_max]
    if(x < 0.0) {
        x = -x;
    } else if(x > x_max) {
        x = 2 * x_max - x;
    }
    // Reflect y if out of [0, y_max]
    if(y < 0.0) {
        y = -y;
    } else if(y > y_max) {
        y = 2 * y_max - y;
    }
    return { {z, y, x}, hit_boundary };
}
