#include "walker.h"
#include <iostream>
#include <numeric>  // for std::accumulate
#include <cmath>    // for std::floor, std::exp, std::sqrt


// Initialize thread-local random engine with non-deterministic seed
thread_local std::mt19937 RandomWalker::rng( std::random_device{}() );

RandomWalker::RandomWalker(GeometryConfig* geometry_config,
                           size_t max_steps_val,
                           double eps_val,
                           double delta_x_val)
    : geom(geometry_config), max_steps(max_steps_val), eps(eps_val), delta_x(delta_x_val) {}

    double RandomWalker::simulate_temperature(const std::array<double,3>& x0_meter,
        size_t N, size_t num_workers, size_t print_interval) {
        std::vector<double> results(N);
        size_t print_step = std::max(size_t(1), print_interval);

        // Set the number of threads (optional; default is usually all cores)
        if (num_workers > 0)
        omp_set_num_threads(num_workers);

        // Parallel for loop with OpenMP
        #pragma omp parallel for
        for (size_t i = 0; i < N; ++i) {
        // Create a thread-local walker (if your walker is not thread safe)
        // Otherwise, if simulate_single_path is thread safe, just call it.
        results[i] = simulate_single_path(x0_meter);
        }

        // Optionally print progress (after the loop)
        for (size_t i = print_step; i <= N; i += print_step) {
        double current_mean = std::accumulate(results.begin(), results.begin() + i, 0.0) / i;
        std::cout << "[" << i << "/" << N << "] Current Mean: "
        << current_mean << std::endl;
        }

        double total_sum = std::accumulate(results.begin(), results.end(), 0.0);
        return results.empty() ? 0.0 : total_sum / results.size();
}

double RandomWalker::simulate_single_path(const std::array<double,3>& x0_meter) {
    std::array<double,3> pos = x0_meter;
    // T_i accumulators: [heat_source, Dirichlet, Neumann, Robin] contributions
    double T_i[4] = {0.0, 0.0, 0.0, 0.0};
    double e_hat = 1.0;
    bool in_robin = false;
    int near_robin = 0;
    int hit_robin = 0;
    double robin_parameter = 0.0;
    size_t step_count = 0;
    // Random walk simulation loop
    while (step_count < max_steps && e_hat > eps) {
        std::string region = geom->get_region_by_coord(pos[0]);
        auto [bc_pos, bc_type, bc_param] = geom->is_near_boundary(pos);
        if (bc_pos.empty()) {
            // Not near Dirichlet/Neumann/Robin boundary
            if (region == "heat_source" || region == "virtual_top" || region == "virtual_bottom") {
                // Within a heat source region or virtual extension region
                double reward = (region == "heat_source") ? get_heat_reward(pos) : 0.0;
                T_i[0] += e_hat * reward;
                pos = step_wog(pos);  // take a grid step
            } else {
                // In non-source region (top or bottom bulk region)
                if (in_robin) {
                    // If previously in a Robin boundary scenario, finalize it upon leaving
                    auto [subT3, new_e_hat] = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
                    T_i[3] += subT3;
                    e_hat = new_e_hat;
                    in_robin = false;
                    near_robin = 0;
                    hit_robin = 0;
                    robin_parameter = 0.0;
                }
                pos = step_wos(pos).first;  // Walk on Spheres step in bulk region
            }
        } else {
            // Near an actual boundary (top or bottom)
            if (bc_type == "Dirichlet") {
                // Hit a Dirichlet (fixed temperature) boundary
                double phi = bc_param;
                T_i[1] += e_hat * phi;
                break;  // terminate this path (absorbed)
            } else {
                // Neumann or Robin boundary handling
                bool is_top = (bc_pos == "top");
                bool is_bottom = (bc_pos == "bottom");
                // Determine if extremely close to boundary (within Δx)
                bool is_very_close = false;
                if (is_top && pos[0] >= geom->nz_total * geom->z_resolution - delta_x) {
                    is_very_close = true;
                } else if (is_bottom && pos[0] <= delta_x) {
                    is_very_close = true;
                }
                double step_length = is_very_close ? (2 * delta_x) : delta_x;
                if (bc_type == "Neumann") {
                    // Accumulate Neumann boundary contribution
                    double dL = estimate_local_time_increment(bc_type);
                    double phi = bc_param;
                    T_i[2] += e_hat * phi * dL;
                    pos = step_wos(pos, step_length).first;
                } else if (bc_type == "Robin") {
                    // Enter or remain in Robin boundary interaction mode
                    if (!in_robin) {
                        in_robin = true;
                        robin_parameter = bc_param;
                    }
                    near_robin += 1;
                    bool hit_boundary;
                    std::tie(pos, hit_boundary) = step_wos(pos, step_length);
                    if (hit_boundary) {
                        hit_robin += 1;
                    }
                }
            }
        }
        ++step_count;
    }
    // If path ended while still in Robin mode, finalize the Robin contributions
    if (in_robin) {
        auto [subT3, new_e_hat] = escape_robin(e_hat, hit_robin, near_robin, robin_parameter);
        T_i[3] += subT3;
        e_hat = new_e_hat;
    }
    return T_i[0] + T_i[1] + T_i[2] + T_i[3];
}

std::pair<double,double> RandomWalker::escape_robin(double e_hat, int hit_robin, int near_robin, double robin_parameter) {
    // Finalize contributions after leaving a Robin boundary region
    double sub_T3 = 0.0;
    double h = robin_parameter;
    double k = 395.0;
    double c = -h / k;
    double phi = -c * geom->T_am;
    if (hit_robin > 0) {
        double avg_steps_per_hit = static_cast<double>(near_robin) / hit_robin;
        for (int i = 0; i < hit_robin; ++i) {
            double dL = estimate_local_time_increment("Robin") * avg_steps_per_hit;
            e_hat *= std::exp(c * dL);
            sub_T3 += e_hat * phi * dL;
        }
    }
    // Return the accumulated contribution and the updated e_hat
    return { sub_T3, e_hat };
}

double RandomWalker::get_heat_reward(const std::array<double,3>& pos) {
    // Compute heat source reward at the current position
    double z = pos[0], y = pos[1], x = pos[2];
    int iz = static_cast<int>(std::floor(z / geom->z_resolution)) - geom->z_heat_start;
    int iy = static_cast<int>(std::floor(y / geom->xy_resolution));
    int ix = static_cast<int>(std::floor(x / geom->xy_resolution));
    if (iz >= 0 && iz < geom->nz_heat && iy >= 0 && iy <= geom->ny && ix >= 0 && ix <= geom->nx) {
        double total_g = get_gt(pos);
        // Index into the power_density array (which is padded in Y and X dimensions)
        size_t idx = (static_cast<size_t>(iz) * geom->power_dim_y + iy) * geom->power_dim_x + ix;
        double p = geom->power_density[idx];
        return (total_g > 0.0 ? p / total_g : 0.0);
    }
    return 0.0;
}

double RandomWalker::get_gt(const std::array<double,3>& pos) {
    // Sum of conductances in all 6 directions at this position
    std::array<double,6> conductances = geom->get_conductance(pos);
    double sum = 0.0;
    for (double g : conductances) {
        sum += g;
    }
    return sum;
}

double RandomWalker::estimate_local_time_increment(const std::string& bc_type) {
    // Compute Δt (local time increment) for boundary type using delta_x and epsilon (diffusion properties)
    double epsilon = geom->boundary_epsilon.at(bc_type);
    double d = delta_x;
    return (d * d) / (6.0 * epsilon);
}

std::pair<std::array<double,3>, bool> RandomWalker::step_wos(const std::array<double,3>& pos, double radius) {
    // Walk-on-Spheres (WOS) step from position `pos` with given radius (or compute radius if -1)
    double z = pos[0];
    std::string region = geom->get_region_by_coord(z);
    if (region != "top" && region != "bottom") {
        throw std::runtime_error("step_wos called outside top/bottom region");
    }
    // Determine jump radius
    if (radius < 0.0) {  
        // Calculate radius to nearest boundary (either domain boundary or edge of heat source region)
        if (region == "top") {
            double z_upper = (geom->z_top_end + 1) * geom->z_resolution;
            double dist_to_heat_bottom = z - (geom->z_heat_end + 1) * geom->z_resolution;
            double dist_to_top_boundary = z_upper - z;
            radius = std::min(dist_to_heat_bottom, dist_to_top_boundary);
        } else { // region == "bottom"
            double z_lower = geom->z_bottom_start * geom->z_resolution;
            double dist_to_heat_top = geom->z_heat_start * geom->z_resolution - z;
            double dist_to_bottom_boundary = z - z_lower;
            radius = std::min(dist_to_heat_top, dist_to_bottom_boundary);
        }
    }
    // Sample a random direction uniformly on the surface of a sphere:contentReference[oaicite:2]{index=2}
    static thread_local std::normal_distribution<double> normal_dist(0.0, 1.0);
    double a = normal_dist(rng);
    double b = normal_dist(rng);
    double c = normal_dist(rng);
    double norm = std::sqrt(a*a + b*b + c*c);
    if (norm < 1e-16) norm = 1e-16;
    std::array<double,3> unit_vec = { a / norm, b / norm, c / norm };
    // Compute the new position after the jump
    std::array<double,3> new_pos = { pos[0] + radius * unit_vec[0],
                                     pos[1] + radius * unit_vec[1],
                                     pos[2] + radius * unit_vec[2] };
    // Reflect the new position if it goes out of domain bounds
    bool hit_boundary;
    std::tie(new_pos, hit_boundary) = reflect(new_pos);
    // If landed in a virtual layer (just outside the real domain), snap to nearest grid point
    std::string new_region = geom->get_region_by_coord(new_pos[0]);
    if (new_region == "virtual_top" || new_region == "virtual_bottom") {
        int z_idx = static_cast<int>(std::floor(new_pos[0] / geom->z_resolution));
        int y_idx = static_cast<int>(std::floor(new_pos[1] / geom->xy_resolution));
        int x_idx = static_cast<int>(std::floor(new_pos[2] / geom->xy_resolution));
        std::array<double,3> snapped_pos = {
            z_idx * geom->z_resolution,
            y_idx * geom->xy_resolution,
            x_idx * geom->xy_resolution
        };
        return { snapped_pos, hit_boundary };
    }
    return { new_pos, hit_boundary };
}

std::array<double,3> RandomWalker::step_wog(const std::array<double,3>& pos) {
    // Walk-on-Grid (WOG) step: choose a neighbor direction with probability proportional to conductance
    std::array<double,6> g_vals = geom->get_conductance(pos);
    double total_g = 0.0;
    for (double g : g_vals) {
        total_g += g;
    }
    if (total_g <= 0.0) {
        return pos; // no movement if no conductance (should not happen under normal conditions)
    }
    // Generate a uniform random number and pick a direction weighted by conductances:contentReference[oaicite:3]{index=3}
    static thread_local std::uniform_real_distribution<double> uniform_dist(0.0, 1.0);
    double r = uniform_dist(rng) * total_g;
    double cumulative = 0.0;
    int chosen_index = 0;
    for (int i = 0; i < 6; ++i) {
        cumulative += g_vals[i];
        if (r <= cumulative) {
            chosen_index = i;
            break;
        }
    }
    // Direction vectors (parallel to axes) corresponding to indices: +x, -x, +y, -y, +z, -z
    std::array<std::array<double,3>,6> directions = {{
        { 0.0, 0.0,  geom->xy_resolution },   // +x
        { 0.0, 0.0, -geom->xy_resolution },   // -x
        { 0.0,  geom->xy_resolution, 0.0 },   // +y
        { 0.0, -geom->xy_resolution, 0.0 },   // -y
        {  geom->z_resolution, 0.0, 0.0 },    // +z
        { -geom->z_resolution, 0.0, 0.0 }     // -z
    }};
    std::array<double,3> new_pos = {
        pos[0] + directions[chosen_index][0],
        pos[1] + directions[chosen_index][1],
        pos[2] + directions[chosen_index][2]
    };
    // Reflect if the step goes out of lateral bounds (X or Y)
    auto [reflected_pos, hit] = reflect(new_pos);
    (void)hit;  // hit flag (top/bottom boundary) is not relevant here
    return reflected_pos;
}

std::pair<std::array<double,3>, bool> RandomWalker::reflect(const std::array<double,3>& pos) {
    // Reflect a position back into the domain if it goes out of bounds.
    std::array<double,3> rpos = pos;
    bool hit_boundary = false;
    double x_max = geom->nx * geom->xy_resolution;
    double y_max = geom->ny * geom->xy_resolution;
    double z_max = geom->nz_total * geom->z_resolution;
    // Check and clamp Z (vertical) coordinate
    if (rpos[0] < 0.0 || rpos[0] > z_max) {
        hit_boundary = true;
    }
    if (rpos[0] < 0.0) rpos[0] = 0.0;
    if (rpos[0] > z_max) rpos[0] = z_max;
    // Reflect X and Y coordinates if outside [0, x_max] or [0, y_max]
    if (rpos[2] < 0.0) rpos[2] = -rpos[2];
    if (rpos[2] > x_max) rpos[2] = 2 * x_max - rpos[2];
    if (rpos[1] < 0.0) rpos[1] = -rpos[1];
    if (rpos[1] > y_max) rpos[1] = 2 * y_max - rpos[1];
    return { rpos, hit_boundary };
}
