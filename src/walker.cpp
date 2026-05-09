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
#include <unordered_map>
#include <chrono>
#include <limits>
#include <fstream>
#include <filesystem>
#include <stdexcept>
#include "json.hpp"
using json = nlohmann::json;
// Thread-local random number generator (Mersenne Twister) seeded with a random device
static thread_local std::mt19937 rng((std::random_device())());




void write_constraints_to_json(
    const std::vector<std::vector<PassSample>>& all_pass_samples,
    int M, int N, const std::vector<std::vector<double>>& obs_data,
    const std::string& filename = "outputs/data.json"
) {
    std::vector<int> i_k;
    std::vector<int> j_k;
    std::vector<double> alpha_k;
    std::vector<double> b_k;

    for (int i = 0; i < all_pass_samples.size(); ++i) {
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

    std::filesystem::path output_path(filename);
    if (output_path.has_parent_path()) {
        std::filesystem::create_directories(output_path.parent_path());
    }
    std::ofstream out(output_path);
    out << std::setw(2) << j << std::endl;
}

void add_robin_side_diagnostics(RobinPathDiagnostics& diag,
                                const std::string& boundary_position,
                                double hit_count,
                                double near_count,
                                double local_time,
                                double t3,
                                double log_decay) {
    if (boundary_position == "top") {
        diag.top_hit_count += hit_count;
        diag.top_near_count += near_count;
        diag.top_local_time += local_time;
        diag.top_T3 += t3;
    } else if (boundary_position == "bottom") {
        diag.bottom_hit_count += hit_count;
        diag.bottom_near_count += near_count;
        diag.bottom_local_time += local_time;
        diag.bottom_T3 += t3;
    }
    diag.total_T3 += t3;
    diag.robin_log_decay += log_decay;
}

void accumulate_robin_diagnostics(RobinPathDiagnostics& dst, const RobinPathDiagnostics& src) {
    dst.top_hit_count += src.top_hit_count;
    dst.top_near_count += src.top_near_count;
    dst.top_local_time += src.top_local_time;
    dst.top_T3 += src.top_T3;
    dst.bottom_hit_count += src.bottom_hit_count;
    dst.bottom_near_count += src.bottom_near_count;
    dst.bottom_local_time += src.bottom_local_time;
    dst.bottom_T3 += src.bottom_T3;
    dst.total_T3 += src.total_T3;
    dst.robin_log_decay += src.robin_log_decay;
    dst.robin_decay += src.robin_decay;
}

void write_robin_diagnostics_to_json(
    const std::vector<Position>& start_points,
    const std::vector<MultiPointStats>& stats,
    const std::vector<RobinPathDiagnostics>& diagnostic_sums,
    int N,
    const std::string& mode,
    const std::string& filename
) {
    if (filename.empty()) return;

    json j;
    j["samples"] = N;
    j["robin_local_time_mode"] = mode;
    j["point_diagnostics"] = json::array();

    for (size_t i = 0; i < start_points.size(); ++i) {
        const RobinPathDiagnostics& sums = diagnostic_sums[i];
        const auto& p = start_points[i];
        json point;
        point["point"] = i;
        point["x"] = p[2];
        point["y"] = p[1];
        point["z"] = p[0];
        point["normal_mean"] = stats[i].normal_mean;
        point["robin"] = {
            {"hit_count_mean", (sums.top_hit_count + sums.bottom_hit_count) / N},
            {"near_count_mean", (sums.top_near_count + sums.bottom_near_count) / N},
            {"effective_local_time_mean", (sums.top_local_time + sums.bottom_local_time) / N},
            {"T3_robin_mean", sums.total_T3 / N},
            {"exp_minus_hL_over_k_mean", sums.robin_decay / N},
            {"log_decay_mean", sums.robin_log_decay / N},
            {"top_hit_count_mean", sums.top_hit_count / N},
            {"top_near_count_mean", sums.top_near_count / N},
            {"top_effective_local_time_mean", sums.top_local_time / N},
            {"top_T3_robin_mean", sums.top_T3 / N},
            {"bottom_hit_count_mean", sums.bottom_hit_count / N},
            {"bottom_near_count_mean", sums.bottom_near_count / N},
            {"bottom_effective_local_time_mean", sums.bottom_local_time / N},
            {"bottom_T3_robin_mean", sums.bottom_T3 / N}
        };
        j["point_diagnostics"].push_back(point);
    }

    std::filesystem::path output_path(filename);
    if (output_path.has_parent_path()) {
        std::filesystem::create_directories(output_path.parent_path());
    }
    std::ofstream out(output_path);
    out << std::setw(2) << j << std::endl;
}


// RandomWalker constructor
RandomWalker::RandomWalker(GeometryConfig& geometry_config, double max_steps_, double eps_, double delta_x_, bool use_tail_correction_,
                           std::string robin_local_time_mode_, std::optional<unsigned int> seed)
: geom(geometry_config), max_steps(max_steps_), eps(eps_), delta_x(delta_x_), use_tail_correction(use_tail_correction_) {
    if (robin_local_time_mode_ == "current") {
        robin_local_time_mode = RobinLocalTimeMode::Current;
    } else if (robin_local_time_mode_ == "event") {
        robin_local_time_mode = RobinLocalTimeMode::Event;
    } else if (robin_local_time_mode_ == "hit") {
        robin_local_time_mode = RobinLocalTimeMode::Hit;
    } else {
        throw std::runtime_error("Unknown walker.robin_local_time_mode: " + robin_local_time_mode_
            + " (expected \"current\", \"event\", or \"hit\")");
    }
    if (seed.has_value()) {
        rng.seed(*seed);
    }
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

std::vector<MultiPointStats> RandomWalker::simulate_temperature_multi(
    const std::vector<Position>& start_points, int N,
    int num_workers, int print_interval, const std::string& constraints_json,
    const std::string& diagnostics_json) {

    int M = static_cast<int>(start_points.size());
    if (M == 0 || N <= 0) return {};

    if (num_workers <= 0) {
        num_workers = static_cast<int>(std::thread::hardware_concurrency());
        if (num_workers < 1) num_workers = 1;  // fallback to 1 if system returns 0
    }


    std::vector<std::vector<double>> obs_data(N, std::vector<double>(M, 0.0));
    std::vector<std::vector<PassSample>> all_pass_samples(M);
    // 新增：每个起点累计步数（全局）
    std::vector<long long> total_steps_per_point(M, 0);
    std::vector<RobinPathDiagnostics> diagnostic_sums(M);

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
            std::vector<RobinPathDiagnostics> thread_diagnostic_sums(M);

            while (true) {
                int task_idx = next_task.fetch_add(1);
                if (task_idx >= total_tasks) break;

                int i = task_idx / N;
                int n = task_idx % N;

                RobinPathDiagnostics path_diag;
                auto result = simulate_single_path_record(start_points[i], target_map, &path_diag);
                path_diag.robin_decay = std::exp(path_diag.robin_log_decay);
                double T_val = std::get<0>(result);
                const auto& passes = std::get<1>(result);
                int step_count = std::get<2>(result);
                thread_obs_data[n][i] = T_val;
                thread_pass_samples[i].insert(thread_pass_samples[i].end(), passes.begin(), passes.end());
                thread_steps_per_point[i] += step_count;
                accumulate_robin_diagnostics(thread_diagnostic_sums[i], path_diag);
            }

            std::lock_guard<std::mutex> lock(mtx);
            for (int i = 0; i < M; ++i) {
                all_pass_samples[i].insert(all_pass_samples[i].end(),
                                           thread_pass_samples[i].begin(), thread_pass_samples[i].end());
                total_steps_per_point[i] += thread_steps_per_point[i];
                accumulate_robin_diagnostics(diagnostic_sums[i], thread_diagnostic_sums[i]);
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

    // 写入 JSON 文件
    write_constraints_to_json(all_pass_samples, M, N, obs_data, constraints_json);

    // 构造返回值
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
        stats[i] = { count, normal_mean, avg_steps };
    }
    write_robin_diagnostics_to_json(start_points, stats, diagnostic_sums, N,
        robin_local_time_mode == RobinLocalTimeMode::Current ? "current" :
        (robin_local_time_mode == RobinLocalTimeMode::Event ? "event" : "hit"),
        diagnostics_json);
    return stats;
}

std::tuple<double, std::string, int> RandomWalker::simulate_single_path(const Position& x0_meter) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    int near_robin = 0;
    int hit_robin = 0;
    bool in_robin = false;
    double robin_parameter = 0.0;
    std::string robin_boundary_position;
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
                if(e_hat < eps && region == "heat_source" ){
                    if(use_tail_correction) {
                        T_i[1] += e_hat * geom.get_temperature_at(pos);
                    }
                    break;
                }
                pos = step_wog(pos);
            } else {
                if(in_robin) {
                    auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter, robin_boundary_position);
                    double sub_T3 = result.first;
                    e_hat = result.second;
                    T_i[3] += sub_T3;
                    near_robin = 0;
                    hit_robin = 0;
                    in_robin = false;
                    robin_parameter = 0.0;
                    robin_boundary_position.clear();
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
                    int near_increment = is_very_close ? 4 : 1;

                    bool boundary_hit;
                    if(robin_local_time_mode == RobinLocalTimeMode::Current) {
                        if(!in_robin) {
                            assert(near_robin == 0 && hit_robin == 0);
                            in_robin = true;
                            robin_parameter = bc_param;
                            robin_boundary_position = bc_pos;
                        }
                        near_robin += near_increment;
                    } else if(robin_local_time_mode == RobinLocalTimeMode::Event) {
                        double sub_T3 = 0.0;
                        e_hat = apply_robin_local_time(e_hat,
                            estimate_local_time_increment(GeometryConfig::BoundaryType::Robin) * near_increment,
                            bc_param, bc_pos, sub_T3);
                        T_i[3] += sub_T3;
                    }
                    std::tie(pos, boundary_hit) = step_wos(pos, step_length);
                    if(boundary_hit && robin_local_time_mode == RobinLocalTimeMode::Current) {
                        hit_robin += 1;
                    } else if(boundary_hit && robin_local_time_mode == RobinLocalTimeMode::Hit) {
                        double sub_T3 = 0.0;
                        e_hat = apply_robin_local_time(e_hat,
                            estimate_local_time_increment(GeometryConfig::BoundaryType::Robin) * near_increment,
                            bc_param, bc_pos, sub_T3);
                        T_i[3] += sub_T3;
                    }
                }
            }
        }
        step_count++;
    }
    if(in_robin) {
        auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter, robin_boundary_position);
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

std::tuple<double, std::vector<PassSample>, int>
RandomWalker::simulate_single_path_record(
    const Position& x0_meter,
    const std::unordered_map<GridIndex,int,GridIndexHash>& target_map,
    RobinPathDiagnostics* diagnostics) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    int near_robin = 0;
    int hit_robin = 0;
    bool in_robin = false;
    double robin_parameter = 0.0;
    std::string robin_boundary_position;
    int step_count = 0;

    // double ISEDA_last_prediction = 0.0;
    // std::vector<double> ISEDA_acc;
    // std::ofstream outfile("./output.txt", std::ios::app);


    std::string end_boundary;
    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;

    int last_record = 0;

    std::vector<PassSample> pass_samples;

    while(step_count < max_steps) {
        std::string region = geom.get_region_by_coord(pos[0]);

        if(step_count - last_record > 1000 && region == "heat_source") {
            int iz = static_cast<int>(std::floor(pos[0] / geom.z_resolution));
            int iy = static_cast<int>(std::floor(pos[1] / geom.xy_resolution));
            int ix = static_cast<int>(std::floor(pos[2] / geom.xy_resolution));
            GridIndex gi{iz, iy, ix};
            auto it = target_map.find(gi);
            if(it != target_map.end()) {
                if(std::abs(1.0 - e_hat) > 0.1) {
                    double reward = get_heat_reward(pos);
                    double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3] + e_hat * reward;
                    pass_samples.push_back({it->second, t_sum, e_hat});
                    last_record = step_count;
                }
            }
        }

        // ISEDA
        // if((step_count+1)%400000 ==0){
        //     ISEDA_acc.push_back((T_i[0] + T_i[1] + T_i[2] + T_i[3]));
        //     if(ISEDA_acc.size()>=0){
        //         // 倒数第1个
        //         double last1 = ISEDA_acc[ISEDA_acc.size() - 1];
        //         // 倒数第2个
        //         double last2 = ISEDA_acc[ISEDA_acc.size() - 2];
        //         // 倒数第3个
        //         double last3 = ISEDA_acc[ISEDA_acc.size() - 3];

        //         double current_prediction = (last2*last2 - last1*last3)/(last2+last2-last1-last3+1e-8);
        //         double diff = current_prediction - ISEDA_last_prediction;

        //         outfile <<(step_count+1)/400000 << "   " << e_hat << std::endl;
                // if(std::abs(diff)<0.2){
                //     outfile.close();
                //     return { current_prediction, pass_samples, step_count };
                // }
                // else{
                //     ISEDA_last_prediction = current_prediction;
                // }
        //     }
        // }

        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);
        if(!isNear) {
            if(region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;

                // FastRW Zixiao
                if(e_hat < eps && region == "heat_source" ){
                    if(use_tail_correction) {
                        T_i[1] += e_hat * geom.get_temperature_at(pos);
                    }
                    break;
                }
                // PIRW
                // if(e_hat < 0.0001 ){
                //     break;
                // }

                pos = step_wog(pos);
            }else {
                if(in_robin) {
                    auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter, robin_boundary_position, diagnostics);
                    double sub_T3 = result.first;
                    e_hat = result.second;
                    T_i[3] += sub_T3;
                    near_robin = 0;
                    hit_robin = 0;
                    in_robin = false;
                    robin_parameter = 0.0;
                    robin_boundary_position.clear();
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
                    int near_increment = is_very_close ? 4 : 1;
                    if (diagnostics != nullptr && robin_local_time_mode != RobinLocalTimeMode::Current) {
                        add_robin_side_diagnostics(*diagnostics, bc_pos, 0.0, near_increment, 0.0, 0.0, 0.0);
                    }

                    bool boundary_hit;
                    if(robin_local_time_mode == RobinLocalTimeMode::Current) {
                        if(!in_robin) {
                            assert(near_robin == 0 && hit_robin == 0);
                            in_robin = true;
                            robin_parameter = bc_param;
                            robin_boundary_position = bc_pos;
                        }
                        near_robin += near_increment;
                    } else if(robin_local_time_mode == RobinLocalTimeMode::Event) {
                        double sub_T3 = 0.0;
                        e_hat = apply_robin_local_time(e_hat,
                            estimate_local_time_increment(GeometryConfig::BoundaryType::Robin) * near_increment,
                            bc_param, bc_pos, sub_T3, diagnostics);
                        T_i[3] += sub_T3;
                    }
                    std::tie(pos, boundary_hit) = step_wos(pos, step_length);
                    if(boundary_hit) {
                        if (diagnostics != nullptr && robin_local_time_mode != RobinLocalTimeMode::Current) {
                            add_robin_side_diagnostics(*diagnostics, bc_pos, 1.0, 0.0, 0.0, 0.0, 0.0);
                        }
                        if(robin_local_time_mode == RobinLocalTimeMode::Current) {
                            hit_robin += 1;
                        } else if(robin_local_time_mode == RobinLocalTimeMode::Hit) {
                            double sub_T3 = 0.0;
                            e_hat = apply_robin_local_time(e_hat,
                                estimate_local_time_increment(GeometryConfig::BoundaryType::Robin) * near_increment,
                                bc_param, bc_pos, sub_T3, diagnostics);
                            T_i[3] += sub_T3;
                        }
                    }
                }
            }
        }
        step_count++;
    }
    if(in_robin) {
        auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter, robin_boundary_position, diagnostics);
        T_i[3] += result.first;
        e_hat = result.second;
    }

    double total_T = T_i[0] + T_i[1] + T_i[2] + T_i[3];

    return { total_T, pass_samples, step_count };
}

double RandomWalker::apply_robin_local_time(double e_hat, double dL, double robin_param,
                                            const std::string& boundary_position,
                                            double& sub_T3,
                                            RobinPathDiagnostics* diagnostics) {
    double h = robin_param;
    double k = geom.k_medium;
    double c = -h / k;
    double phi = -c * geom.T_am;
    double decay = c * dL;
    e_hat *= std::exp(decay);
    double t3 = e_hat * phi * dL;
    sub_T3 += t3;
    if (diagnostics != nullptr) {
        add_robin_side_diagnostics(*diagnostics, boundary_position, 0.0, 0.0, dL, t3, decay);
    }
    return e_hat;
}

std::pair<double, double> RandomWalker::escape_robin(double e_hat, int hit_robin, int near_robin,
                                                     double robin_param, const std::string& boundary_position,
                                                     RobinPathDiagnostics* diagnostics) {
    double sub_T3 = 0.0;
    if(hit_robin == 0) {
        // No Robin boundary hits, no contribution
    } else {
        // Average steps per boundary hit in Robin region
        double avg_step_per_hit = (hit_robin > 0) ? (static_cast<double>(near_robin) / hit_robin) : 0.0;
        for(int i = 0; i < hit_robin; ++i) {
            double dL = estimate_local_time_increment(GeometryConfig::BoundaryType::Robin) * avg_step_per_hit;
            e_hat = apply_robin_local_time(e_hat, dL, robin_param, boundary_position, sub_T3, diagnostics);
        }
    }
    if (diagnostics != nullptr) {
        add_robin_side_diagnostics(*diagnostics, boundary_position, hit_robin, near_robin, 0.0, 0.0, 0.0);
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


std::vector<std::array<double, 3>> RandomWalker::simulate_temperature_trace(
    const Position& x0_meter,
    const std::string& out_txt,
    int record_interval,
    int print_interval
) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;

    int near_robin = 0;
    int hit_robin = 0;
    bool in_robin = false;
    double robin_parameter = 0.0;

    int step_count = 0;

    // 记录“最近一次在 heat_source 时”的 local 温度
    double last_heat_temp = std::numeric_limits<double>::quiet_NaN();
    bool has_heat_temp = false;

    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;

    std::vector<std::array<double, 3>> trace;
    if (record_interval > 0 && max_steps > 0) {
        // 粗略 reserve，避免频繁扩容
        trace.reserve(static_cast<size_t>(static_cast<long long>(max_steps) / record_interval + 4));
    }

    // 主循环：逻辑尽量保持与 simulate_single_path 一致
    while (step_count < max_steps) {
        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);

        if (!isNear) {
            std::string region = geom.get_region_by_coord(pos[0]);

            if (region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;

                // 原逻辑：在 heat_source 且 e_hat 很小 -> 用 local 温度收尾
                if (e_hat < eps && region == "heat_source") {
                    if(use_tail_correction) {
                        T_i[1] += e_hat * geom.get_temperature_at(pos);
                    }
                    // break 前不强行补记录（严格“每隔固定间隙”才记）
                    break;
                }

                pos = step_wog(pos);
            } else {
                // 离开 robin 区域时结算
                if (in_robin) {
                    auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
                    T_i[3] += result.first;
                    e_hat = result.second;

                    near_robin = 0;
                    hit_robin = 0;
                    in_robin = false;
                    robin_parameter = 0.0;
                }
                pos = step_wos(pos).first;
            }

        } else {
            // near boundary
            if (bc_type == GeometryConfig::BoundaryType::Dirichlet) {
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                break;
            } else {
                bool is_top = (bc_pos == "top");
                bool is_very_close = false;
                if (is_top) {
                    is_very_close = (pos[0] >= geom.nz_total * geom.z_resolution - delta_x);
                } else {
                    is_very_close = (pos[0] <= delta_x);
                }

                double step_length = is_very_close ? (2 * delta_x) : delta_x;

                if (bc_type == GeometryConfig::BoundaryType::Neumann) {
                    double dL = estimate_local_time_increment(bc_type);
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                    pos = step_wos(pos, step_length).first;
                } else if (bc_type == GeometryConfig::BoundaryType::Robin) {
                    if (!in_robin) {
                        in_robin = true;
                        robin_parameter = bc_param;
                        // 原代码里有 assert(near_robin==0 && hit_robin==0)，保持语义
                        near_robin = 0;
                        hit_robin = 0;
                    }

                    if (is_very_close) {
                        near_robin += 4;
                    } else {
                        near_robin += 1;
                    }

                    bool boundary_hit = false;
                    std::tie(pos, boundary_hit) = step_wos(pos, step_length);
                    if (boundary_hit) {
                        hit_robin += 1;
                    }
                }
            }
        }

        // 完成一步
        step_count++;

        // 更新 last_heat_temp（基于“走完这一步后的当前位置”）
        {
            std::string region_now = geom.get_region_by_coord(pos[0]);
            if (region_now == "heat_source") {
                last_heat_temp = geom.get_temperature_at(pos);
                has_heat_temp = true;
            }
        }

        // 定期记录
        if (record_interval > 0 && (step_count % record_interval == 0)) {
            double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
            double heat_temp_to_log = has_heat_temp ? last_heat_temp
                                                    : std::numeric_limits<double>::quiet_NaN();
            trace.push_back({t_sum, heat_temp_to_log, e_hat});
        }

        // 可选打印
        if (print_interval > 0 && (step_count % print_interval == 0)) {
            double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
            std::cout << "[trace] step=" << step_count
                      << "  t_sum=" << t_sum
                      << "  last_heat_T=" << (has_heat_temp ? last_heat_temp : std::nan(""))
                      << "  e_hat=" << e_hat << std::endl;
        }
    }

    // 末尾如果还在 robin，按原逻辑结算（不额外补记录，仍保持“固定间隙记录”）
    if (in_robin) {
        auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
        T_i[3] += result.first;
        e_hat = result.second;
    }

    // 写 txt：N×3，每行三列
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
        out.close();
    }

    return trace;
}


std::tuple<std::array<double, 3>, bool, int>
RandomWalker::simulate_single_path_random_cutoff(
    const Position& x0_meter,
    double e_target,
    double e_min,
    double e_max
) {
    Position pos = x0_meter;
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;

    int near_robin = 0;
    int hit_robin = 0;
    bool in_robin = false;
    double robin_parameter = 0.0;

    int step_count = 0;

    std::string bc_pos;
    GeometryConfig::BoundaryType bc_type;
    double bc_param;

    while (step_count < max_steps) {
        std::string region = geom.get_region_by_coord(pos[0]);
        bool isNear = geom.is_near_boundary(pos, bc_pos, bc_type, bc_param);

        if (!isNear) {
            if (region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                // 积分项：先按原逻辑加 reward
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;

                // ★ 随机截断：只允许在 heat_source 内截断
                if (region == "heat_source") {
                    // 你要求：e_hat ∈ [e_min, e_max] 时截断（并且是随机的 e_target）
                    // 这里用：e_hat <= e_target 触发（e_hat 单调下降时很常用）
                    if (e_hat >= e_min && e_hat <= e_max && e_hat <= e_target) {
                        double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
                        double local_T = geom.get_temperature_at(pos);
                        return { {t_sum, e_hat, local_T}, true, step_count };
                    }

                    // 仍保留你原先的“很小 e_hat 快速收尾”逻辑（可选）
                    if (e_hat < eps) {
                        if(use_tail_correction) {
                            T_i[1] += e_hat * geom.get_temperature_at(pos);
                        }
                        break;
                    }
                }

                pos = step_wog(pos);
            } else {
                if (in_robin) {
                    auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
                    T_i[3] += result.first;
                    e_hat = result.second;

                    near_robin = 0;
                    hit_robin = 0;
                    in_robin = false;
                    robin_parameter = 0.0;
                }
                pos = step_wos(pos).first;
            }
        } else {
            if (bc_type == GeometryConfig::BoundaryType::Dirichlet) {
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                break;
            } else {
                bool is_top = (bc_pos == "top");
                bool is_very_close = false;
                if (is_top) {
                    is_very_close = (pos[0] >= geom.nz_total * geom.z_resolution - delta_x);
                } else {
                    is_very_close = (pos[0] <= delta_x);
                }
                double step_length = is_very_close ? (2 * delta_x) : delta_x;

                if (bc_type == GeometryConfig::BoundaryType::Neumann) {
                    double dL = estimate_local_time_increment(bc_type);
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                    pos = step_wos(pos, step_length).first;
                } else if (bc_type == GeometryConfig::BoundaryType::Robin) {
                    if (!in_robin) {
                        in_robin = true;
                        robin_parameter = bc_param;
                        near_robin = 0;
                        hit_robin = 0;
                    }
                    near_robin += is_very_close ? 4 : 1;

                    bool boundary_hit;
                    std::tie(pos, boundary_hit) = step_wos(pos, step_length);
                    if (boundary_hit) hit_robin += 1;
                }
            }
        }

        step_count++;
    }

    if (in_robin) {
        auto result = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
        T_i[3] += result.first;
        e_hat = result.second;
    }

    // 没成功截断：返回 NaN local_temperature（因为你要求只在 heat_source 截断才有效）
    double t_sum = T_i[0] + T_i[1] + T_i[2] + T_i[3];
    double nan = std::numeric_limits<double>::quiet_NaN();
    return { {t_sum, e_hat, nan}, false, step_count };
}


std::vector<std::array<double, 3>> RandomWalker::simulate_temperature_random_cutoff(
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
        // 每个线程各自的分布器
        std::uniform_real_distribution<double> uni(e_min, e_max);

        while (true) {
            int i = next_task.fetch_add(1);
            if (i >= N) break;

            std::array<double, 3> row;
            bool ok = false;
            int steps_used = 0;

            for (int attempt = 0; attempt < max_attempts_per_path; ++attempt) {
                double e_target = uni(rng);  // thread_local rng
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

    // 写 txt：每行 [T_sum, e_hat, local_temperature]
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
