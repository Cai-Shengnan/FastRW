#ifndef SIMULATION_CONFIG_H
#define SIMULATION_CONFIG_H

#include <array>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "geometry.h"

struct BoundaryConfig {
    GeometryConfig::BoundaryType type = GeometryConfig::BoundaryType::Robin;
    double param = 0.0;
};

struct SimulationConfig {
    struct Geometry {
        double x_size = 2e-2;
        double y_size = 2e-2;
        double top_thickness = 5e-4;
        double middle_thickness = 1e-4;
        double bottom_thickness = 1e-3;
        double xy_resolution = 2e-4;
        double z_resolution = 2e-5;
        double ambient_temperature = 293.15;
        double source_conductivity = 125.0;
        double medium_conductivity = 395.0;
    };

    struct Boundary {
        BoundaryConfig top;
        BoundaryConfig bottom;
        BoundaryConfig lateral;
        double eps_dirichlet = 1e-8;
        double eps_neumann = 1.5 * 5e-7;
        double eps_robin = 1.5 * 5e-7;
    };

    struct Walker {
        double max_steps = 5e7;
        double cutoff_weight = 0.01;
        double delta_x = 5e-7;
        bool use_tail_correction = true;
        std::string tail_mode = "gt";
        std::string robin_local_time_mode = "current";
        struct Diagnostics {
            bool enabled = false;
        } diagnostics;
    };

    struct QueryGrid {
        std::vector<int> x_indices;
        std::vector<int> y_indices;
        bool has_z = false;
        double z = 0.0;
        double x_offset = 0.0;
        double y_offset = 0.0;
        double z_offset = 0.0;
    };

    struct Output {
        std::filesystem::path directory;
        std::string csv = "FastRw.csv";
        std::string constraints = "data.json";
        std::string diagnostics = "diagnostics.json";
    };

    struct Run {
        int num_samples = 400;
        int num_workers = -1;
        std::optional<unsigned int> seed;
    };

    std::string case_name;
    std::string power_map;
    Geometry geometry;
    Boundary boundary;
    Walker walker;
    QueryGrid query_grid;
    Output output;
    Run run;
    std::filesystem::path power_density_path;
    std::filesystem::path ground_truth_path;
    double power_scale = 1.0;
    double temperature_offset = 273.15;

    static SimulationConfig load(const std::filesystem::path& config_path);
    std::vector<std::array<double, 3>> make_query_points() const;
};

#endif
