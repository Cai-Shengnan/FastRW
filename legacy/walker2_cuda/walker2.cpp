#include "walker2.h"
#include <iostream>
#include <random>
#include <thread>
#include <mutex>
#include <numeric>
#include <cmath>
#include <cassert>
#include <atomic>
#include <iomanip>
#include <unordered_map>
#include <chrono>
#include <limits>
#include <fstream>
#include "json.hpp"

using json = nlohmann::json;

// Thread-local random number generator (Mersenne Twister) seeded with a random device
static thread_local std::mt19937 rng((std::random_device())());

namespace {
void write_constraints_to_json(
    const std::vector<std::vector<PassSample>>& all_pass_samples,
    int M, int N, const std::vector<std::vector<double>>& obs_data,
    const std::string& filename = "data.json"
) {
    std::vector<int> i_k;
    std::vector<int> j_k;
    std::vector<double> alpha_k;
    std::vector<double> b_k;

    for (int i = 0; i < static_cast<int>(all_pass_samples.size()); ++i) {
        for (const auto& ps : all_pass_samples[i]) {
            i_k.push_back(i + 1);  // Stan uses 1-based indexing
            j_k.push_back(ps.target_index + 1);
            alpha_k.push_back(ps.e_hat);
            b_k.push_back(ps.t_sum);
        }
    }

    json j;
    j["M"] = M;
    j["N"] = N;
    j["K"] = static_cast<int>(i_k.size());

    j["i_k"] = i_k;
    j["j_k"] = j_k;
    j["alpha_k"] = alpha_k;
    j["b_k"] = b_k;

    // 将 obs_data 转换为二维数组
    j["obs_data"] = obs_data;

    std::ofstream out(filename);
    out << std::setw(2) << j << std::endl;
}
} // namespace

RandomWalker2::RandomWalker2(GeometryConfig& geometry_config, double max_steps_, double eps_, double delta_x_)
: geom(geometry_config), max_steps(max_steps_), eps(eps_), delta_x(delta_x_) {}

double RandomWalker2::simulate_temperature(const Position& x0_meter, int N, int num_workers, int print_interval) {
    if (N <= 0) return 0.0;

    std::vector<double> samples;
    samples.reserve(N);
    long long total_steps = 0;

    int workers = (num_workers <= 0 ? static_cast<int>(std::thread::hardware_concurrency()) : num_workers);
    if (workers < 1) workers = 1;

    if (workers == 1) {
        double sum = 0.0;
        for (int i = 0; i < N; ++i) {
            auto result = simulate_single_path(x0_meter);
            double value = std::get<0>(result);
            int steps = std::get<2>(result);
            sum += value;
            total_steps += steps;
            samples.push_back(value);

            if (print_interval > 0 && (i + 1) % print_interval == 0) {
                double current_mean = sum / (i + 1);
                std::cout << "[" << (i + 1) << "/" << N
                          << "] Current Mean: " << std::fixed << std::setprecision(6) << current_mean
                          << std::endl;
            }
        }
    } else {
        int tasks_per_thread = N / workers;
        int remainder = N % workers;
        std::vector<std::thread> threads;
        std::mutex mutex;
        threads.reserve(workers);

        for (int t = 0; t < workers; ++t) {
            int count = tasks_per_thread + (t < remainder ? 1 : 0);
            threads.emplace_back([&, count]() {
                std::vector<double> local_samples;
                long long local_steps = 0;
                for (int j = 0; j < count; ++j) {
                    auto result = simulate_single_path(x0_meter);
                    double value = std::get<0>(result);
                    int steps = std::get<2>(result);
                    local_samples.push_back(value);
                    local_steps += steps;
                }
                std::lock_guard<std::mutex> lock(mutex);
                samples.insert(samples.end(), local_samples.begin(), local_samples.end());
                total_steps += local_steps;
            });
        }

        for (auto& th : threads) {
            if (th.joinable()) th.join();
        }
    }

    double total = std::accumulate(samples.begin(), samples.end(), 0.0);
    double mean = total / N;
    double avg_steps = static_cast<double>(total_steps) / N;
    std::cout << "Average steps per path: " << avg_steps << std::endl;
    return mean;
}

std::vector<MultiPointStats> RandomWalker2::simulate_temperature_multi(
    const std::vector<Position>& start_points, int N, int num_workers, int print_interval) {

    int M = static_cast<int>(start_points.size());
    if (M == 0 || N <= 0) return {};

    if (num_workers <= 0) {
        num_workers = static_cast<int>(std::thread::hardware_concurrency());
        if (num_workers < 1) num_workers = 1;
    }

    std::vector<std::vector<double>> obs_data(N, std::vector<double>(M, 0.0));
    std::vector<std::vector<PassSample>> all_pass_samples(M);
    std::vector<long long> total_steps_per_point(M, 0);

    std::unordered_map<GridIndex, int, GridIndexHash> target_map;
    for (int i = 0; i < M; ++i) {
        int iz = static_cast<int>(std::floor(start_points[i][0] / geom.z_resolution));
        int iy = static_cast<int>(std::floor(start_points[i][1] / geom.xy_resolution));
        int ix = static_cast<int>(std::floor(start_points[i][2] / geom.xy_resolution));
        target_map[{iz, iy, ix}] = i;
    }

    std::atomic<int> next_task(0);
    int total_tasks = M * N;
    std::mutex mtx;
    std::cout << "Launching simulation with " << num_workers << " threads" << std::endl;

    auto sim_start = std::chrono::high_resolution_clock::now();

    std::vector<std::thread> threads;
    for (int t = 0; t < num_workers; ++t) {
        threads.emplace_back([&]() {
            std::vector<std::vector<PassSample>> thread_pass_samples(M);
            std::vector<std::vector<double>> thread_obs_data(N, std::vector<double>(M, 0.0));
            std::vector<long long> thread_steps_per_point(M, 0);

            while (true) {
                int task_idx = next_task.fetch_add(1);
                if (task_idx >= total_tasks) break;

                int i = task_idx / N;
                int n = task_idx % N;

                auto result = simulate_single_path_record(start_points[i], target_map);
                double T_val = std::get<0>(result);
                const auto& passes = std::get<1>(result);
                int step_count = std::get<2>(result);
                thread_obs_data[n][i] = T_val;
                thread_pass_samples[i].insert(thread_pass_samples[i].end(), passes.begin(), passes.end());
                thread_steps_per_point[i] += step_count;
            }

            std::lock_guard<std::mutex> lock(mtx);
            for (int i = 0; i < M; ++i) {
                all_pass_samples[i].insert(all_pass_samples[i].end(),
                                           thread_pass_samples[i].begin(), thread_pass_samples[i].end());
                total_steps_per_point[i] += thread_steps_per_point[i];
            }
            for (int n = 0; n < N; ++n) {
                for (int i = 0; i < M; ++i) {
                    obs_data[n][i] += thread_obs_data[n][i];
                }
            }
        });
    }

    for (auto& th : threads) {
        if (th.joinable()) th.join();
    }

    auto sim_end = std::chrono::high_resolution_clock::now();
    std::cout << "Simulation complete in "
              << std::chrono::duration<double>(sim_end - sim_start).count()
              << " seconds." << std::endl;

    write_constraints_to_json(all_pass_samples, M, N, obs_data);

    std::vector<MultiPointStats> stats(M);
    for (int i = 0; i < M; ++i) {
        double sum = 0.0;
        int count = 0;
        for (int n = 0; n < N; ++n) {
            sum += obs_data[n][i];
            count++;
        }
        double normal_mean = (count > 0) ? (sum / count) : 0.0;
        double avg_steps = (N > 0) ? (static_cast<double>(total_steps_per_point[i]) / N) : 0.0;
        stats[i] = {count, normal_mean, avg_steps};
    }
    return stats;
}

std::tuple<double, std::string, int> RandomWalker2::simulate_single_path(const Position& x0_meter) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    int step_count = 0;

    std::string end_boundary;
    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;

    while (step_count < max_steps) {
        std::string region = geom.get_region_by_coord(pos[0]);
        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);

        if (!isNear) {
            if (region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;
                if (e_hat < 0.01 && region == "heat_source") {
                    T_i[1] += e_hat * geom.get_temperature_at(pos);
                    break;
                }
                pos = step_wog(pos);
            } else {
                pos = step_wos(pos).first;
            }
        } else {
            if (bc_type == GeometryConfig::BoundaryType::Dirichlet) {
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                end_boundary = bc_pos;
                break;
            }

            // Paper-style boundary strip random walk on D_eps:
            // - 6-direction move with d=distance to boundary
            // - If it "lands on" the z-boundary, reflect back to current position
            double d = distance_to_z_boundary(pos, bc_pos);
            bool boundary_hit = false;
            std::tie(pos, boundary_hit) = step_boundary_strip(pos, bc_pos);
            if (boundary_hit) {
                double dL = d;  // paper Eq.(17): dL ≈ d
                if (bc_type == GeometryConfig::BoundaryType::Neumann) {
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                } else if (bc_type == GeometryConfig::BoundaryType::Robin) {
                    double h = bc_param;
                    double k = 395.0;
                    double c = -h / k;
                    double phi = -c * geom.T_am;
                    e_hat *= std::exp(c * dL);
                    T_i[3] += e_hat * phi * dL;
                }
            }
        }

        step_count++;
    }

    double total_T = T_i[0] + T_i[1] + T_i[2] + T_i[3];
    return {total_T, end_boundary, step_count};
}

std::tuple<double, std::string, int> RandomWalker2::simulate_single_path_wrapper(const Position& x0_meter) {
    rng.seed(std::random_device()());
    return simulate_single_path(x0_meter);
}

std::tuple<double, std::vector<PassSample>, int>
RandomWalker2::simulate_single_path_record(
    const Position& x0_meter,
    const std::unordered_map<GridIndex,int,GridIndexHash>& target_map) {

    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    int step_count = 0;

    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;

    int last_record = 0;
    std::vector<PassSample> pass_samples;

    while (step_count < max_steps) {
        std::string region = geom.get_region_by_coord(pos[0]);

        if (step_count - last_record > 1000 && region == "heat_source") {
            int iz = static_cast<int>(std::floor(pos[0] / geom.z_resolution));
            int iy = static_cast<int>(std::floor(pos[1] / geom.xy_resolution));
            int ix = static_cast<int>(std::floor(pos[2] / geom.xy_resolution));
            GridIndex gi{iz, iy, ix};
            auto it = target_map.find(gi);
            if (it != target_map.end()) {
                if (std::abs(1.0 - e_hat) > 0.1) {
                    double reward = get_heat_reward(pos);
                    double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3] + e_hat * reward;
                    pass_samples.push_back({it->second, t_sum, e_hat});
                    last_record = step_count;
                }
            }
        }

        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);
        if (!isNear) {
            if (region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;

                if (e_hat < 0.03 && region == "heat_source") {
                    T_i[1] += e_hat * geom.get_temperature_at(pos);
                    break;
                }

                pos = step_wog(pos);
            } else {
                pos = step_wos(pos).first;
            }
        } else {
            if (bc_type == GeometryConfig::BoundaryType::Dirichlet) {
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                break;
            }

            double d = distance_to_z_boundary(pos, bc_pos);
            bool boundary_hit = false;
            std::tie(pos, boundary_hit) = step_boundary_strip(pos, bc_pos);
            if (boundary_hit) {
                double dL = d;
                if (bc_type == GeometryConfig::BoundaryType::Neumann) {
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                } else if (bc_type == GeometryConfig::BoundaryType::Robin) {
                    double h = bc_param;
                    double k = 395.0;
                    double c = -h / k;
                    double phi = -c * geom.T_am;
                    e_hat *= std::exp(c * dL);
                    T_i[3] += e_hat * phi * dL;
                }
            }
        }
        step_count++;
    }

    double total_T = T_i[0] + T_i[1] + T_i[2] + T_i[3];
    return {total_T, pass_samples, step_count};
}

std::pair<double, double> RandomWalker2::escape_robin(double e_hat, int hit_robin, int near_robin, double robin_param) {
    // Kept for parity with v1; v2's main loop updates Robin contributions per-hit (paper-style).
    double sub_T3 = 0.0;
    double h = robin_param;
    double k = 395.0;
    double c = -h / k;
    double phi = -c * geom.T_am;
    if (hit_robin > 0) {
        double avg_step_per_hit = (hit_robin > 0) ? (static_cast<double>(near_robin) / hit_robin) : 0.0;
        for (int i = 0; i < hit_robin; ++i) {
            double dL = estimate_local_time_increment(GeometryConfig::BoundaryType::Robin) * avg_step_per_hit;
            e_hat *= std::exp(c * dL);
            sub_T3 += e_hat * phi * dL;
        }
    }
    return {sub_T3, e_hat};
}

double RandomWalker2::get_heat_reward(const Position& pos) {
    double z = pos[0];
    double y = pos[1];
    double x = pos[2];
    int iz = static_cast<int>(std::floor(z / geom.z_resolution)) - geom.z_heat.first;
    int iy = static_cast<int>(std::floor(y / geom.xy_resolution));
    int ix = static_cast<int>(std::floor(x / geom.xy_resolution));
    if (iz >= 0 && iz < geom.nz_heat && iy >= 0 && iy <= geom.ny && ix >= 0 && ix <= geom.nx) {
        double power = geom.power_density[iz][iy][ix];
        double gt_val = get_gt(pos);
        if (gt_val > 0) return power / gt_val;
    }
    return 0.0;
}

double RandomWalker2::get_gt(const Position& pos) {
    std::array<double,6> cond = geom.get_conductance(pos);
    double total = 0.0;
    for (double g : cond) total += g;
    return total;
}

double RandomWalker2::estimate_local_time_increment(GeometryConfig::BoundaryType bc_type) {
    double epsilon = geom.boundary_epsilon[static_cast<int>(bc_type)];
    double delta = delta_x;
    return (delta * delta) / (6.0 * epsilon);
}

std::pair<Position, bool> RandomWalker2::step_wos(const Position& pos, double radius) {
    double z = pos[0];
    std::string region = geom.get_region_by_coord(z);
    double r;
    if (radius < 0) {
        if (region == "top") {
            double z_upper = (geom.z_top.second + 1) * geom.z_resolution;
            double dist_to_heat_top = z - (geom.z_heat.second + 1) * geom.z_resolution;
            double dist_to_top_boundary = z_upper - z;
            r = std::min(dist_to_heat_top, dist_to_top_boundary);
        } else {
            double z_lower = geom.z_bottom.first * geom.z_resolution;
            double dist_to_heat_bottom = geom.z_heat.first * geom.z_resolution - z;
            double dist_to_bottom_boundary = z - z_lower;
            r = std::min(dist_to_heat_bottom, dist_to_bottom_boundary);
        }
    } else {
        r = radius;
    }

    std::normal_distribution<double> normal_dist(0.0, 1.0);
    double vx = normal_dist(rng);
    double vy = normal_dist(rng);
    double vz = normal_dist(rng);
    double norm = std::sqrt(vx*vx + vy*vy + vz*vz);
    vx /= norm;
    vy /= norm;
    vz /= norm;

    Position new_pos = { pos[0] + r * vz, pos[1] + r * vy, pos[2] + r * vx };
    bool hit_boundary;
    std::tie(new_pos, hit_boundary) = reflect(new_pos);

    std::string new_region = geom.get_region_by_coord(new_pos[0]);
    if (new_region == "virtual_top" || new_region == "virtual_bottom") {
        int z_idx = static_cast<int>(std::floor(new_pos[0] / geom.z_resolution));
        int y_idx = static_cast<int>(std::floor(new_pos[1] / geom.xy_resolution));
        int x_idx = static_cast<int>(std::floor(new_pos[2] / geom.xy_resolution));
        double z_snap = z_idx * geom.z_resolution + geom.z_resolution / 2.0;
        double y_snap = y_idx * geom.xy_resolution + geom.xy_resolution / 2.0;
        double x_snap = x_idx * geom.xy_resolution + geom.xy_resolution / 2.0;
        return {{z_snap, y_snap, x_snap}, hit_boundary};
    }

    return {new_pos, hit_boundary};
}

Position RandomWalker2::step_wog(const Position& pos) {
    std::array<double, 6> g = geom.get_conductance(pos);
    double total_g = 0.0;
    for (double val : g) total_g += val;
    if (total_g <= 0.0) return pos;

    Position directions[6] = {
        {0.0, 0.0, geom.xy_resolution},
        {0.0, 0.0, -geom.xy_resolution},
        {0.0, geom.xy_resolution, 0.0},
        {0.0, -geom.xy_resolution, 0.0},
        {geom.z_resolution, 0.0, 0.0},
        {-geom.z_resolution, 0.0, 0.0}
    };

    std::discrete_distribution<int> dist(g.begin(), g.end());
    int choice = dist(rng);
    Position direction_vector = directions[choice];
    Position new_pos = { pos[0] + direction_vector[0], pos[1] + direction_vector[1], pos[2] + direction_vector[2] };

    double new_x = new_pos[2];
    double new_y = new_pos[1];
    if (new_x < 0.0 || new_x > geom.x_size || new_y < 0.0 || new_y > geom.y_size) {
        return reflect(new_pos).first;
    }
    return new_pos;
}

std::pair<Position, bool> RandomWalker2::reflect(const Position& pos) {
    bool hit_boundary = false;
    double z = pos[0];
    double y = pos[1];
    double x = pos[2];
    double x_max = geom.nx * geom.xy_resolution;
    double y_max = geom.ny * geom.xy_resolution;
    double z_max = geom.nz_total * geom.z_resolution;

    if (z < 0.0 || z > z_max) hit_boundary = true;
    if (z < 0.0) z = 0.0;
    if (z > z_max) z = z_max;

    if (x < 0.0) {
        x = -x;
    } else if (x > x_max) {
        x = 2 * x_max - x;
    }

    if (y < 0.0) {
        y = -y;
    } else if (y > y_max) {
        y = 2 * y_max - y;
    }

    return {{z, y, x}, hit_boundary};
}

double RandomWalker2::distance_to_z_boundary(const Position& pos, const std::string& bc_pos) const {
    double z = pos[0];
    double z_max = geom.nz_total * geom.z_resolution;
    double d = 0.0;
    if (bc_pos == "top") {
        d = z_max - z;
    } else if (bc_pos == "bottom") {
        d = z;
    }
    if (d <= 0.0) {
        double fallback = std::min(delta_x, geom.z_resolution * 0.5);
        if (fallback <= 0.0) fallback = std::numeric_limits<double>::epsilon();
        d = fallback;
    }
    return d;
}

std::pair<Position, bool> RandomWalker2::step_boundary_strip(const Position& pos, const std::string& bc_pos) {
    double d = distance_to_z_boundary(pos, bc_pos);

    std::uniform_int_distribution<int> dist(0, 5);
    int choice = dist(rng);

    bool boundary_hit = ((bc_pos == "top" && choice == 4) || (bc_pos == "bottom" && choice == 5));
    if (boundary_hit) {
        // Paper Fig.6(b): reflect back to x1 (current pos)
        return {pos, true};
    }

    Position new_pos = pos;
    switch (choice) {
        case 0: new_pos[2] += d; break; // +x
        case 1: new_pos[2] -= d; break; // -x
        case 2: new_pos[1] += d; break; // +y
        case 3: new_pos[1] -= d; break; // -y
        case 4: new_pos[0] += d; break; // +z (away from bottom boundary)
        case 5: new_pos[0] -= d; break; // -z (away from top boundary)
        default: break;
    }

    // Lateral reflection if needed (z should already stay in range)
    new_pos = reflect(new_pos).first;
    return {new_pos, false};
}

std::vector<std::array<double, 3>> RandomWalker2::simulate_temperature_trace(
    const Position& x0_meter,
    const std::string& out_txt,
    int record_interval,
    int print_interval
) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    int step_count = 0;

    double last_heat_temp = std::numeric_limits<double>::quiet_NaN();
    bool has_heat_temp = false;

    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;

    std::vector<std::array<double, 3>> trace;
    if (record_interval > 0 && max_steps > 0) {
        trace.reserve(static_cast<size_t>(static_cast<long long>(max_steps) / record_interval + 4));
    }

    while (step_count < max_steps) {
        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);

        if (!isNear) {
            std::string region = geom.get_region_by_coord(pos[0]);

            if (region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;

                if (e_hat < 0.01 && region == "heat_source") {
                    T_i[1] += e_hat * geom.get_temperature_at(pos);
                    break;
                }

                pos = step_wog(pos);
            } else {
                pos = step_wos(pos).first;
            }
        } else {
            if (bc_type == GeometryConfig::BoundaryType::Dirichlet) {
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                break;
            }

            double d = distance_to_z_boundary(pos, bc_pos);
            bool boundary_hit = false;
            std::tie(pos, boundary_hit) = step_boundary_strip(pos, bc_pos);
            if (boundary_hit) {
                double dL = d;
                if (bc_type == GeometryConfig::BoundaryType::Neumann) {
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                } else if (bc_type == GeometryConfig::BoundaryType::Robin) {
                    double h = bc_param;
                    double k = 395.0;
                    double c = -h / k;
                    double phi = -c * geom.T_am;
                    e_hat *= std::exp(c * dL);
                    T_i[3] += e_hat * phi * dL;
                }
            }
        }

        step_count++;

        {
            std::string region_now = geom.get_region_by_coord(pos[0]);
            if (region_now == "heat_source") {
                last_heat_temp = geom.get_temperature_at(pos);
                has_heat_temp = true;
            }
        }

        if (record_interval > 0 && (step_count % record_interval == 0)) {
            double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
            double heat_temp_to_log = has_heat_temp ? last_heat_temp
                                                    : std::numeric_limits<double>::quiet_NaN();
            trace.push_back({t_sum, heat_temp_to_log, e_hat});
        }

        if (print_interval > 0 && (step_count % print_interval == 0)) {
            double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
            std::cout << "[trace] step=" << step_count
                      << "  t_sum=" << t_sum
                      << "  last_heat_T=" << (has_heat_temp ? last_heat_temp : std::nan(""))
                      << "  e_hat=" << e_hat << std::endl;
        }
    }

    {
        std::ofstream out(out_txt);
        if (!out.is_open()) {
            std::cerr << "Failed to open output file: " << out_txt << std::endl;
            return trace;
        }
        out << std::setprecision(15);
        for (const auto& row : trace) {
            out << row[0] << " " << row[1] << " " << row[2] << "\n";
        }
    }

    return trace;
}

std::tuple<std::array<double, 3>, bool, int>
RandomWalker2::simulate_single_path_random_cutoff(
    const Position& x0_meter,
    double e_target,
    double e_min,
    double e_max
) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    int step_count = 0;

    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;

    while (step_count < max_steps) {
        std::string region = geom.get_region_by_coord(pos[0]);
        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);

        if (!isNear) {
            if (region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;

                if (region == "heat_source") {
                    if (e_hat >= e_min && e_hat <= e_max && e_hat <= e_target) {
                        double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
                        double local_T = geom.get_temperature_at(pos);
                        return {{t_sum, e_hat, local_T}, true, step_count};
                    }
                    if (e_hat < 0.01) {
                        T_i[1] += e_hat * geom.get_temperature_at(pos);
                        break;
                    }
                }

                pos = step_wog(pos);
            } else {
                pos = step_wos(pos).first;
            }
        } else {
            if (bc_type == GeometryConfig::BoundaryType::Dirichlet) {
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                break;
            }

            double d = distance_to_z_boundary(pos, bc_pos);
            bool boundary_hit = false;
            std::tie(pos, boundary_hit) = step_boundary_strip(pos, bc_pos);
            if (boundary_hit) {
                double dL = d;
                if (bc_type == GeometryConfig::BoundaryType::Neumann) {
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                } else if (bc_type == GeometryConfig::BoundaryType::Robin) {
                    double h = bc_param;
                    double k = 395.0;
                    double c = -h / k;
                    double phi = -c * geom.T_am;
                    e_hat *= std::exp(c * dL);
                    T_i[3] += e_hat * phi * dL;
                }
            }
        }

        step_count++;
    }

    double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
    double nan = std::numeric_limits<double>::quiet_NaN();
    return {{t_sum, e_hat, nan}, false, step_count};
}

std::vector<std::array<double, 3>> RandomWalker2::simulate_temperature_random_cutoff(
    const Position& x0_meter,
    int N,
    const std::string& out_txt,
    int num_workers,
    int print_interval,
    int max_attempts_per_path,
    double e_min,
    double e_max
) {
    if (N <= 0) return {};

    int workers = (num_workers <= 0 ? static_cast<int>(std::thread::hardware_concurrency()) : num_workers);
    if (workers < 1) workers = 1;

    std::vector<std::array<double, 3>> results(N, {
        std::numeric_limits<double>::quiet_NaN(),
        std::numeric_limits<double>::quiet_NaN(),
        std::numeric_limits<double>::quiet_NaN()
    });

    std::atomic<int> next_task(0);
    std::atomic<int> finished(0);

    auto worker_fn = [&]() {
        std::uniform_real_distribution<double> uni(e_min, e_max);

        while (true) {
            int i = next_task.fetch_add(1);
            if (i >= N) break;

            std::array<double, 3> row;
            bool ok = false;
            int steps_used = 0;

            for (int attempt = 0; attempt < max_attempts_per_path; ++attempt) {
                double e_target = uni(rng);
                auto res = simulate_single_path_random_cutoff(x0_meter, e_target, e_min, e_max);
                row = std::get<0>(res);
                ok  = std::get<1>(res);
                steps_used = std::get<2>(res);
                if (ok) break;
            }

            results[i] = row;

            int done = finished.fetch_add(1) + 1;
            if (print_interval > 0 && (done % print_interval == 0)) {
                std::cout << "[" << done << "/" << N << "] done. "
                          << "last_ok=" << (ok ? "true" : "false")
                          << " steps=" << steps_used << std::endl;
            }
        }
    };

    if (workers == 1) {
        worker_fn();
    } else {
        std::vector<std::thread> threads;
        threads.reserve(workers);
        for (int t = 0; t < workers; ++t) threads.emplace_back(worker_fn);
        for (auto& th : threads) if (th.joinable()) th.join();
    }

    {
        std::ofstream out(out_txt);
        if (!out.is_open()) {
            std::cerr << "Failed to open output file: " << out_txt << std::endl;
            return results;
        }
        out << std::setprecision(15);
        for (const auto& r : results) {
            out << r[0] << " " << r[1] << " " << r[2] << "\n";
        }
    }

    return results;
}
