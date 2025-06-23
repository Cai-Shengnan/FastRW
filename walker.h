#ifndef WALKER_H
#define WALKER_H

#include "geometry.h"
#include <omp.h> 
#include <array>
#include <random>

class RandomWalker {
public:
    RandomWalker(GeometryConfig* geometry_config,
                 size_t max_steps_val = 6e6,
                 double eps_val = 5e-4,
                 double delta_x_val = 5e-7);
    // Run N independent random walk simulations from starting position x0, return average temperature
    double simulate_temperature(const std::array<double,3>& x0_meter, size_t N=5000,
                                size_t num_workers=0, size_t print_interval=100);
    // Simulate a single random walk path from x0 (returns the accumulated temperature contribution)
    double simulate_single_path(const std::array<double,3>& x0_meter);

private:
    GeometryConfig* geom;
    size_t max_steps;
    double eps;
    double delta_x;
    // Thread-local random number generator for reproducibility
    static thread_local std::mt19937 rng;
    // Internal helper methods corresponding to Python's internal functions
    std::pair<double,double> escape_robin(double e_hat, int hit_robin, int near_robin, double robin_parameter);
    double get_heat_reward(const std::array<double,3>& pos);
    double get_gt(const std::array<double,3>& pos);
    double estimate_local_time_increment(const std::string& bc_type);
    std::pair<std::array<double,3>, bool> step_wos(const std::array<double,3>& pos, double radius = -1.0);
    std::array<double,3> step_wog(const std::array<double,3>& pos);
    std::pair<std::array<double,3>, bool> reflect(const std::array<double,3>& pos);
};

#endif // WALKER_H
