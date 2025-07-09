#ifndef RANDOM_WALKER_H
#define RANDOM_WALKER_H

#include <vector>
#include <array>
#include <string>
#include "geometry.h"

// Define a type for 3D position (z, y, x) coordinates in meters
using Position = std::array<double, 3>;

class RandomWalker {
public:
    // Constructor: initializes RandomWalker with given geometry configuration and parameters.
    RandomWalker(GeometryConfig& geometry_config, double max_steps = 6e6, 
                 double eps = 5e-4, double delta_x = 5e-7);

    // Run N random walk simulations to estimate temperature (expected value).
    // Returns the average result of simulate_single_path over N runs.
    // Optionally uses multiple threads for parallel simulation.
    double simulate_temperature(const Position& x0_meter, int N = 5000, 
                                int num_workers = -1, int print_interval = 100);

    // Simulate a single random walk path. 
    // Returns a pair: (computed temperature contribution, boundary_position where the walk ended ["top"/"bottom" or empty if none]).
    std::tuple<double, std::string> simulate_single_path(const Position& x0_meter);

private:
    GeometryConfig& geom;     // Reference to geometry configuration (domain and parameters)
    double max_steps;         // Maximum number of steps per path
    double eps;               // Termination threshold for e_hat (Feynman-Kac weight)
    double delta_x;           // WOS jump radius near boundaries (Δx)

    // Internal function for simulate_temperature parallelization (reseeds RNG for each call if needed).
    std::tuple<double, std::string> simulate_single_path_wrapper(const Position& x0_meter);

    // Helper functions corresponding to internal methods in the Python code:
    // Escape from Robin boundary region: compute contribution and update e_hat.
    std::pair<double, double> escape_robin(double e_hat, int hit_robin, int near_robin, double robin_param);
    // Compute heat source reward (source term contribution) at a given position.
    double get_heat_reward(const Position& pos);
    // Compute total conductance (gt) at a given position by summing all directional conductances.
    double get_gt(const Position& pos);
    // Estimate local time increment for a boundary type (used for Neumann/Robin boundary conditions).
    double estimate_local_time_increment(GeometryConfig::BoundaryType bc_type);
    // Perform one step of Walk-On-Spheres (WOS). If radius is provided, use that; otherwise determine radius based on region.
    // Returns a pair: (new_position, hit_boundary_flag).
    std::pair<Position, bool> step_wos(const Position& pos, double radius = -1.0);
    // Perform one step of Walk-On-Grid (WOG) to a neighboring grid point chosen by conductance-weighted probability.
    Position step_wog(const Position& pos);
    // Reflect a position back into the valid domain if it goes out of bounds.
    // Returns a pair: (reflected_position, hit_boundary_flag).
    std::pair<Position, bool> reflect(const Position& pos);
};

#endif // RANDOM_WALKER_H
