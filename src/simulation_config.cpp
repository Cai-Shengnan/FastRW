#include "simulation_config.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <stdexcept>

#include "json.hpp"

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {
template <typename T>
T get_or(const json& obj, const char* key, const T& fallback) {
    if (!obj.contains(key) || obj.at(key).is_null()) return fallback;
    return obj.at(key).get<T>();
}

std::string lower_copy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

GeometryConfig::BoundaryType parse_boundary_type(const std::string& raw) {
    std::string value = lower_copy(raw);
    if (value == "dirichlet") return GeometryConfig::BoundaryType::Dirichlet;
    if (value == "neumann") return GeometryConfig::BoundaryType::Neumann;
    if (value == "robin") return GeometryConfig::BoundaryType::Robin;
    throw std::runtime_error("Unknown boundary type: " + raw);
}

BoundaryConfig parse_boundary(const json& obj, GeometryConfig::BoundaryType default_type, double default_param) {
    BoundaryConfig config;
    config.type = default_type;
    config.param = default_param;
    if (!obj.is_object()) return config;
    config.type = parse_boundary_type(get_or<std::string>(obj, "type", "Robin"));
    config.param = get_or<double>(obj, "param", default_param);
    return config;
}

fs::path resolve_path(const fs::path& config_dir, const fs::path& raw) {
    if (raw.empty() || raw.is_absolute()) return raw;
    return (config_dir / raw).lexically_normal();
}

std::vector<int> read_indices(const json& obj, const char* key) {
    if (obj.contains(key)) return obj.at(key).get<std::vector<int>>();
    return {10, 20, 30, 40};
}
}

SimulationConfig SimulationConfig::load(const fs::path& config_path) {
    std::ifstream in(config_path);
    if (!in) {
        throw std::runtime_error("Failed to open config file: " + config_path.string());
    }

    json root;
    in >> root;

    fs::path config_dir = fs::absolute(config_path).parent_path();
    SimulationConfig config;
    config.case_name = get_or<std::string>(root, "case_name", config_path.stem().string());
    config.power_map = get_or<std::string>(root, "power_map", "");

    const json geometry = root.value("geometry", json::object());
    config.geometry.x_size = get_or<double>(geometry, "x_size", config.geometry.x_size);
    config.geometry.y_size = get_or<double>(geometry, "y_size", config.geometry.y_size);
    config.geometry.top_thickness = get_or<double>(geometry, "top_thickness", config.geometry.top_thickness);
    config.geometry.middle_thickness = get_or<double>(geometry, "middle_thickness", config.geometry.middle_thickness);
    config.geometry.bottom_thickness = get_or<double>(geometry, "bottom_thickness", config.geometry.bottom_thickness);
    config.geometry.xy_resolution = get_or<double>(geometry, "xy_resolution", config.geometry.xy_resolution);
    config.geometry.z_resolution = get_or<double>(geometry, "z_resolution", config.geometry.z_resolution);
    config.geometry.ambient_temperature = get_or<double>(geometry, "ambient_temperature", config.geometry.ambient_temperature);
    config.geometry.source_conductivity = get_or<double>(geometry, "source_conductivity", config.geometry.source_conductivity);
    config.geometry.medium_conductivity = get_or<double>(geometry, "medium_conductivity", config.geometry.medium_conductivity);

    const json boundary = root.value("boundary", json::object());
    config.boundary.top = parse_boundary(
        boundary.value("top", json::object()),
        GeometryConfig::BoundaryType::Robin,
        8700.0);
    config.boundary.bottom = parse_boundary(
        boundary.value("bottom", json::object()),
        GeometryConfig::BoundaryType::Robin,
        config.boundary.top.param);
    config.boundary.lateral = parse_boundary(
        boundary.value("lateral", json::object()),
        GeometryConfig::BoundaryType::Neumann,
        0.0);
    const json epsilon = boundary.value("epsilon", json::object());
    config.boundary.eps_dirichlet = get_or<double>(epsilon, "dirichlet", config.boundary.eps_dirichlet);
    config.boundary.eps_neumann = get_or<double>(epsilon, "neumann", config.boundary.eps_neumann);
    config.boundary.eps_robin = get_or<double>(epsilon, "robin", config.boundary.eps_robin);

    const json walker = root.value("walker", json::object());
    config.walker.max_steps = get_or<double>(walker, "max_steps", config.walker.max_steps);
    config.walker.cutoff_weight = get_or<double>(walker, "cutoff_weight", config.walker.cutoff_weight);
    config.walker.delta_x = get_or<double>(walker, "delta_x", config.walker.delta_x);
    config.walker.use_tail_correction = get_or<bool>(walker, "use_tail_correction", config.walker.use_tail_correction);
    config.walker.tail_mode = get_or<std::string>(walker, "tail_mode", config.walker.tail_mode);
    config.walker.robin_local_time_mode = get_or<std::string>(walker, "robin_local_time_mode", config.walker.robin_local_time_mode);
    const json diagnostics = walker.value("diagnostics", json::object());
    config.walker.diagnostics.enabled = get_or<bool>(diagnostics, "enabled", config.walker.diagnostics.enabled);

    const json query = root.value("query_grid", json::object());
    config.query_grid.x_indices = read_indices(query, "x_indices");
    config.query_grid.y_indices = read_indices(query, "y_indices");
    config.query_grid.x_offset = get_or<double>(query, "x_offset", config.query_grid.x_offset);
    config.query_grid.y_offset = get_or<double>(query, "y_offset", config.query_grid.y_offset);
    config.query_grid.z_offset = get_or<double>(query, "z_offset", config.query_grid.z_offset);
    if (query.contains("z") && !query.at("z").is_null()) {
        config.query_grid.has_z = true;
        config.query_grid.z = query.at("z").get<double>();
    }

    const json output = root.value("output", json::object());
    config.output.directory = resolve_path(config_dir, get_or<std::string>(output, "directory", "../outputs"));
    config.output.csv = get_or<std::string>(output, "csv", config.output.csv);
    config.output.constraints = get_or<std::string>(output, "constraints", config.output.constraints);
    config.output.diagnostics = get_or<std::string>(output, "diagnostics", config.output.diagnostics);

    const json run = root.value("run", json::object());
    config.run.num_samples = get_or<int>(run, "num_samples", config.run.num_samples);
    config.run.num_workers = get_or<int>(run, "num_workers", config.run.num_workers);
    if (run.contains("seed") && !run.at("seed").is_null()) {
        config.run.seed = run.at("seed").get<unsigned int>();
    }

    const json data = root.value("data", json::object());
    if (!data.contains("power_density_path") || !data.contains("ground_truth_path")) {
        throw std::runtime_error("Config must provide data.power_density_path and data.ground_truth_path");
    }
    config.power_density_path = resolve_path(config_dir, data.at("power_density_path").get<std::string>());
    config.ground_truth_path = resolve_path(config_dir, data.at("ground_truth_path").get<std::string>());
    config.power_scale = get_or<double>(data, "power_scale", config.power_scale);
    config.temperature_offset = get_or<double>(data, "temperature_offset", config.temperature_offset);

    return config;
}

std::vector<std::array<double, 3>> SimulationConfig::make_query_points() const {
    std::vector<std::array<double, 3>> points;
    double z = query_grid.has_z
        ? query_grid.z
        : geometry.bottom_thickness + 0.5 * geometry.middle_thickness;
    z += query_grid.z_offset;

    for (int iy_index : query_grid.y_indices) {
        double y = geometry.xy_resolution * iy_index + query_grid.y_offset;
        for (int ix_index : query_grid.x_indices) {
            double x = geometry.xy_resolution * ix_index + query_grid.x_offset;
            points.push_back({z, y, x});
        }
    }
    return points;
}
