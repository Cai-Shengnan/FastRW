#ifndef RANDOM_WALKER_H
#define RANDOM_WALKER_H

#include <vector>
#include <array>
#include <string>
#include <unordered_map>
#include <optional>


#include "geometry.h"

// Define a type for 3D position (z, y, x) coordinates in meters
using Position = std::array<double, 3>;

struct GridIndex {
    int iz;
    int iy;
    int ix;
    bool operator==(const GridIndex& other) const {
        return iz == other.iz && iy == other.iy && ix == other.ix;
    }
};

struct GridIndexHash {
    std::size_t operator()(const GridIndex& idx) const {
        std::size_t h1 = std::hash<int>()(idx.iz);
        std::size_t h2 = std::hash<int>()(idx.iy);
        std::size_t h3 = std::hash<int>()(idx.ix);
        return h1 ^ (h2 << 1) ^ (h3 << 2);
    }
};

struct PassSample {
    int target_index;  // index of point Y that the path passed through
    double t_sum;      // partial sum when hitting Y
    double e_hat;      // accumulated weight when hitting Y
};

struct MultiPointStats {
    int normal_count;    // number of direct path samples
    double normal_mean; // mean temperature from direct samples
    double avg_steps;     // average number of steps per path (new)
};

struct RobinPathDiagnostics {
    double heat_weighted_reward = 0.0;
    double heat_unweighted_reward = 0.0;
    double heat_e_hat_sum = 0.0;
    double heat_visit_count = 0.0;
    double heat_reward_nonzero_count = 0.0;
    double heat_pending_robin_count = 0.0;
    double heat_pending_robin_unweighted_reward = 0.0;
    double virtual_top_visit_count = 0.0;
    double virtual_bottom_visit_count = 0.0;
    double top_hit_count = 0.0;
    double top_near_count = 0.0;
    double top_local_time = 0.0;
    double top_T3 = 0.0;
    double bottom_hit_count = 0.0;
    double bottom_near_count = 0.0;
    double bottom_local_time = 0.0;
    double bottom_T3 = 0.0;
    double total_T3 = 0.0;
    double robin_log_decay = 0.0;
    double robin_decay = 0.0;
};

class RandomWalker {
public:
    // Constructor: initializes RandomWalker with given geometry configuration and parameters.
    RandomWalker(GeometryConfig& geometry_config, double max_steps = 5e7,
                 double cutoff_weight = 0.01, double delta_x = 5e-7,
                 bool use_tail_correction = true,
                 std::string robin_local_time_mode = "current",
                 std::optional<unsigned int> seed = std::nullopt,
                 std::string tail_mode = "gt");

    // Run N random walk simulations to estimate temperature (expected value).
    // Returns the average result of simulate_single_path over N runs.
    // Optionally uses multiple threads for parallel simulation.
    double simulate_temperature(const Position& x0_meter, int N = 5000,
                                int num_workers = -1, int print_interval = 100);

    // Run N random walks for each position in start_points and reuse paths
    // that pass through other target points to estimate multiple temperatures
    std::vector<MultiPointStats> simulate_temperature_multi(
        const std::vector<Position>& start_points, int N = 5000,
        int num_workers = -1, int print_interval = 100,
        const std::string& constraints_json = "outputs/data.json",
        const std::string& diagnostics_json = "");
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
    double delta_x;           // WOS jump radius near boundaries (Δx)
    bool use_tail_correction; // FastRW uses prior tail correction; PIRW drops the tail.
    enum class TailMode { Gt, None };
    TailMode tail_mode;
    enum class RobinLocalTimeMode { Current, Event, Hit };
    RobinLocalTimeMode robin_local_time_mode;

    // Internal function for simulate_temperature parallelization (reseeds RNG for each call if needed).
    std::tuple<double, std::string, int> simulate_single_path_wrapper(const Position& x0_meter);

    // Simulate a single path and record intermediate estimates when passing
    // through target grid points.
    std::tuple<double, std::vector<PassSample>, int>
    simulate_single_path_record(
        const Position& x0_meter,
        const std::unordered_map<GridIndex,int,GridIndexHash>& target_map,
        RobinPathDiagnostics* diagnostics = nullptr);

    // Single path: sample until cutoff condition in heat_source is met.
    // Return: (row=[T_sum, e_hat, local_temp], success, steps)
    std::tuple<std::array<double, 3>, bool, int> simulate_single_path_random_cutoff(
        const Position& x0_meter,
        double e_target,
        double e_min,
        double e_max
    );

    // Helper functions for boundary/source contributions.
    // Escape from Robin boundary region: compute contribution and update e_hat.
    std::pair<double, double> escape_robin(double e_hat, int hit_robin, int near_robin,
                                           double robin_param, const std::string& boundary_position = "",
                                           RobinPathDiagnostics* diagnostics = nullptr);
    double apply_robin_local_time(double e_hat, double dL, double robin_param,
                                  const std::string& boundary_position,
                                  double& sub_T3,
                                  RobinPathDiagnostics* diagnostics = nullptr);
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
