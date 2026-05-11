#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>

#include "geometry.h"
#include "simulation_config.h"
#include "walker_metal.h"

namespace fs = std::filesystem;

namespace {
fs::path default_config_path(const char* argv0) {
    const fs::path relative_default = fs::path("configs") / "case3_16core.json";
    std::vector<fs::path> candidates = {fs::current_path() / relative_default};

    if (argv0 != nullptr && argv0[0] != '\0') {
        fs::path exe_dir = fs::absolute(argv0).parent_path();
        candidates.push_back(exe_dir / ".." / relative_default);
        candidates.push_back(exe_dir / ".." / ".." / relative_default);
    }

    for (const auto& candidate : candidates) {
        if (fs::exists(candidate)) return candidate.lexically_normal();
    }
    return relative_default;
}
}

int main(int argc, char** argv) {
    fs::path config_path = (argc >= 2) ? fs::path(argv[1]) : default_config_path(argc > 0 ? argv[0] : nullptr);
    SimulationConfig config;
    try {
        config = SimulationConfig::load(config_path);
    } catch (const std::exception& ex) {
        std::cerr << "Failed to load config: " << ex.what() << "\n";
        return 2;
    }

    int num_samples = config.run.num_samples;
    if (argc >= 3) {
        num_samples = std::atoi(argv[2]);
    }
    int threads_per_threadgroup = config.run.num_workers;
    if (argc >= 4) {
        threads_per_threadgroup = std::atoi(argv[3]);
    }
    if (num_samples <= 0) {
        std::cerr << "Invalid num_samples: " << num_samples << " (must be > 0)\n";
        return 2;
    }

    if (!fs::exists(config.power_density_path) ||
        !fs::exists(config.prior_temperature_path) ||
        !fs::exists(config.reference_temperature_path)) {
        std::cerr << "Missing input data files.\n"
                  << "  power_density_path: " << config.power_density_path << "\n"
                  << "  prior_temperature_path: " << config.prior_temperature_path << "\n"
                  << "  reference_temperature_path: " << config.reference_temperature_path << "\n";
        return 2;
    }

    std::cout << "Running Metal config: " << config.case_name << "\n";
    if (!config.power_map.empty()) {
        std::cout << "Power map: " << config.power_map << "\n";
    }

    GeometryConfig geom(
        config.geometry.x_size,
        config.geometry.y_size,
        config.geometry.bottom_thickness,
        config.geometry.middle_thickness,
        config.geometry.top_thickness,
        config.geometry.xy_resolution,
        config.geometry.z_resolution,
        config.boundary.top.type,
        config.boundary.bottom.type,
        config.boundary.top.param,
        config.boundary.bottom.param,
        config.boundary.lateral.type,
        config.boundary.lateral.param,
        config.boundary.eps_dirichlet,
        config.boundary.eps_neumann,
        config.boundary.eps_robin,
        config.geometry.ambient_temperature,
        config.geometry.source_conductivity,
        config.geometry.medium_conductivity,
        config.power_density_path.string()
    );
    geom.scale_power_density(config.power_scale);
    geom.load_prior_temperature_field_from_file(config.prior_temperature_path.string(), config.temperature_offset);
    geom.load_reference_temperature_field_from_file(config.reference_temperature_path.string(), config.temperature_offset);

    RandomWalkerMetal walker(
        geom,
        config.walker.max_steps,
        config.walker.cutoff_weight,
        config.walker.delta_x,
        config.walker.use_tail_correction,
        config.run.seed,
        config.power_scale,
        config.walker.tail_mode,
        config.walker.robin_local_time_mode
    );

    std::vector<Position> points = config.make_query_points();
    std::cout << "Total Point Number = " << points.size() << std::endl;

    fs::create_directories(config.output.directory);
    const fs::path csv_path = config.output.directory / config.output.csv;
    const fs::path compat_csv_path = config.output.directory / "FastRw.csv";
    const fs::path constraints_path = config.output.directory / config.output.constraints;
    const fs::path diagnostics_path = config.output.directory / config.output.diagnostics;

    auto stats = walker.simulate_temperature_multi(
        points,
        num_samples,
        threads_per_threadgroup,
        100,
        constraints_path.string(),
        config.walker.diagnostics.enabled ? diagnostics_path.string() : std::string()
    );

    std::ofstream csv_file(csv_path);
    std::ofstream compat_csv_file;
    if (csv_path.filename() != compat_csv_path.filename()) {
        compat_csv_file.open(compat_csv_path);
    }
    auto write_header = [](std::ofstream& out) {
        if (out) out << "Point,X,Y,Z,Direct_Mean,GT_Temperature,Direct_Error,Avg_Steps\n";
    };
    write_header(csv_file);
    write_header(compat_csv_file);

    for (size_t i = 0; i < stats.size(); ++i) {
        const auto& s = stats[i];
        const auto& p = points[i];
        double gt_temp = geom.get_reference_temperature_at(p);
        double error = s.normal_mean - gt_temp;

        std::cout << "Point " << i
                  << ": direct_mean=" << s.normal_mean
                  << " GT = " << gt_temp
                  << " avg_steps=" << s.avg_steps
                  << std::endl;

        auto write_row = [&](std::ofstream& out) {
            if (out) {
                out << i << ","
                    << p[2] << "," << p[1] << "," << p[0] << ","
                    << s.normal_mean << "," << gt_temp << "," << error << ","
                    << s.avg_steps << "\n";
            }
        };
        write_row(csv_file);
        write_row(compat_csv_file);
    }

    std::cout << "Results saved to " << csv_path << std::endl;
    if (compat_csv_file) {
        std::cout << "Compatibility results saved to " << compat_csv_path << std::endl;
    }
    std::cout << "Constraints saved to " << constraints_path << std::endl;
    return 0;
}
