#ifndef RANDOM_WALKER2_H
#define RANDOM_WALKER2_H

#include "walker.h"

class RandomWalker2 {
public:
    // Constructor: initializes RandomWalker2 with given geometry configuration and parameters.
    RandomWalker2(GeometryConfig& geometry_config, double max_steps = 5e7,
                  double eps = 5e-4, double delta_x = 5e-7);

    // Run N random walk simulations to estimate temperature (expected value).
    // Returns the average result of simulate_single_path over N runs.
    // Optionally uses multiple threads for parallel simulation.
    double simulate_temperature(const Position& x0_meter, int N = 5000,
                                int num_workers = -1, int print_interval = 100);

    // Run N random walks for each position in start_points and reuse paths
    // that pass through other target points to estimate multiple temperatures
    std::vector<MultiPointStats> simulate_temperature_multi(
        const std::vector<Position>& start_points, int N = 5000,
        int num_workers = -1, int print_interval = 100);

    // Run ONE random walk path and record [t_sum, last_heat_local_temp, e_hat]
    // every `record_interval` steps (default 1e5). Save to txt and return Nx3.
    std::vector<std::array<double, 3>> simulate_temperature_trace(
        const Position& x0_meter,
        const std::string& out_txt = "path_trace.txt",
        int record_interval = 100000,
        int print_interval = 100000
    );

    // Run N random walks, randomly stop when (in heat_source) and e_hat hits a random target in [e_min, e_max].
    // Save Nx3 rows: [T_sum, e_hat, local_temperature] to txt and also return them.
    std::vector<std::array<double, 3>> simulate_temperature_random_cutoff(
        const Position& x0_meter,
        int N = 5000,
        const std::string& out_txt = "cutoff_samples.txt",
        int num_workers = -1,
        int print_interval = 100,
        int max_attempts_per_path = 20,
        double e_min = 0.03,
        double e_max = 0.95
    );

    // Simulate a single random walk path.
    // Returns a tuple: (temperature contribution, boundary_position where the
    // walk ended ["top"/"bottom" or empty if none], number of steps taken).
    std::tuple<double, std::string, int> simulate_single_path(const Position& x0_meter);

private:
    GeometryConfig& geom;     // Reference to geometry configuration (domain and parameters)
    double max_steps;         // Maximum number of steps per path
    double eps;               // Termination threshold for e_hat (Feynman-Kac weight)
    double delta_x;           // WOS jump radius near boundaries (Δx) (kept for parity with v1)

    // Optionally reseed RNG and call simulate_single_path (for use in parallel loops)
    std::tuple<double, std::string, int> simulate_single_path_wrapper(const Position& x0_meter);

    // Simulate a single path and record intermediate estimates when passing
    // through target grid points.
    std::tuple<double, std::vector<PassSample>, int>
    simulate_single_path_record(
        const Position& x0_meter,
        const std::unordered_map<GridIndex,int,GridIndexHash>& target_map);

    // Single path: sample until cutoff condition in heat_source is met.
    // Return: (row=[T_sum, e_hat, local_temp], success, steps)
    std::tuple<std::array<double, 3>, bool, int> simulate_single_path_random_cutoff(
        const Position& x0_meter,
        double e_target,
        double e_min,
        double e_max
    );

    // Helper functions corresponding to internal methods in the Python code:
    // Escape from Robin boundary region: compute contribution and update e_hat.
    std::pair<double, double> escape_robin(double e_hat, int hit_robin, int near_robin, double robin_param);
    // Compute heat source reward (source term contribution) at a given position.
    double get_heat_reward(const Position& pos);
    // Compute total conductance (gt) at a given position by summing all directional conductances.
    double get_gt(const Position& pos);
    // Estimate local time increment for a boundary type (kept for parity with v1; v2 uses dL≈d per paper).
    double estimate_local_time_increment(GeometryConfig::BoundaryType bc_type);
    // Perform one step of Walk-On-Spheres (WOS). If radius is provided, use that; otherwise determine radius based on region.
    // Returns a pair: (new_position, hit_boundary_flag).
    std::pair<Position, bool> step_wos(const Position& pos, double radius = -1.0);
    // Perform one step of Walk-On-Grid (WOG) to a neighboring grid point chosen by conductance-weighted probability.
    Position step_wog(const Position& pos);
    // Reflect a position back into the valid domain if it goes out of bounds.
    // Returns a pair: (reflected_position, hit_boundary_flag).
    std::pair<Position, bool> reflect(const Position& pos);

    // === Paper-style boundary strip (D_eps) random walk ===
    // One step in D_eps: 6-direction move with step length d=dist-to-boundary.
    // If it "lands on" the z-boundary, it is immediately reflected back to current pos (paper Fig.6(b)).
    std::pair<Position, bool> step_boundary_strip(const Position& pos, const std::string& bc_pos);
    double distance_to_z_boundary(const Position& pos, const std::string& bc_pos) const;
};

#endif // RANDOM_WALKER2_H
