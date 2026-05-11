#include "geometry.h"
#include <fstream>
#include <stdexcept>


using std::vector;
using std::array;
using std::string;
using std::pair;
using BT = GeometryConfig::BoundaryType;

GeometryConfig::GeometryConfig(double x_size_, double y_size_,
                               double bottom_thickness_, double heat_source_thickness_,
                               double top_thickness_, double xy_resolution_,
                               double z_resolution_,
                               BoundaryType top_boundary_type_,
                               BoundaryType bottom_boundary_type_,
                               double top_boundary_param_,
                               double bottom_boundary_param_,
                               BoundaryType lateral_boundary_type_,
                               double lateral_boundary_param_,
                               double eps_dirichlet,
                               double eps_neumann,
                               double eps_robin,
                               double ambient_temperature,
                               double source_conductivity,
                               double medium_conductivity,
                               const std::string& power_density_path)
: T_am(ambient_temperature),
  k_source(source_conductivity),
  k_medium(medium_conductivity),
  x_size(x_size_), y_size(y_size_),
  bottom_thickness(bottom_thickness_ - 1 * z_resolution_), 
  heat_source_thickness(heat_source_thickness_),
  top_thickness(top_thickness_ - 1 * z_resolution_),
  virtual_layer_thickness(z_resolution_),
  xy_resolution(xy_resolution_), z_resolution(z_resolution_),
  top_boundary_type(top_boundary_type_),
  bottom_boundary_type(bottom_boundary_type_),
  lateral_boundary_type(lateral_boundary_type_),
  top_boundary_param(top_boundary_param_),
  bottom_boundary_param(bottom_boundary_param_),
  lateral_boundary_param(lateral_boundary_param_),
  boundary_epsilon{eps_dirichlet, eps_neumann, eps_robin},
  precompute(false)
{
    // === Compute grid dimensions ===
    nx = static_cast<int>(std::round(x_size / xy_resolution));
    ny = static_cast<int>(std::round(y_size / xy_resolution));
    nz_bottom = static_cast<int>(std::round(bottom_thickness / z_resolution));
    nz_heat   = static_cast<int>(std::round(heat_source_thickness / z_resolution));
    nz_top    = static_cast<int>(std::round(top_thickness / z_resolution));
    nz_virtual = static_cast<int>(std::round(virtual_layer_thickness / z_resolution));
    nz_total  = nz_bottom + 2 * nz_virtual + nz_heat + nz_top;
    // === Define z-index ranges for each region ===
    z_bottom    = {0, nz_bottom - 1};
    z_virtual1  = {z_bottom.second + 1, z_bottom.second + nz_virtual};
    z_heat      = {z_virtual1.second + 1, z_virtual1.second + nz_heat};
    z_virtual2  = {z_heat.second + 1, z_heat.second + nz_virtual};
    z_top       = {z_virtual2.second + 1, nz_total - 1};
    // Initialize the power density array and heat sources
    if (!power_density_path.empty()) {
        std::cout << "[GeometryConfig] Loading power density from file: " << power_density_path << "\n";
        load_power_density_from_file(power_density_path, true);
    } else {
        initialize_heat_sources(true);
    }
    
    // (Optional) Precompute conductance table is off by default (precompute remains false)
    // === Print configuration summary ===
    std::cout << "[GeometryConfig] Initialization Summary:\n";
    std::cout << "  x_size = " << x_size << " m, y_size = " << y_size << " m\n";
    std::cout << "  bottom_thickness = " << bottom_thickness << " m\n";
    std::cout << "  heat_source_thickness = " << heat_source_thickness << " m\n";
    std::cout << "  top_thickness = " << top_thickness << " m\n";
    std::cout << "  virtual_layer_thickness = " << virtual_layer_thickness << " m\n";
    std::cout << "  xy_resolution = " << xy_resolution << " m, z_resolution = " << z_resolution << " m\n";
    std::cout << "  Grid size (nx, ny, nz_total): (" << nx << ", " << ny << ", " << nz_total << ")\n";
    std::cout << "  Z region indices:\n";
    std::cout << "    bottom: (" << z_bottom.first << ", " << z_bottom.second << ")\n";
    std::cout << "    virtual1: (" << z_virtual1.first << ", " << z_virtual1.second << ")\n";
    std::cout << "    heat: (" << z_heat.first << ", " << z_heat.second << ")\n";
    std::cout << "    virtual2: (" << z_virtual2.first << ", " << z_virtual2.second << ")\n";
    std::cout << "    top: (" << z_top.first << ", " << z_top.second << ")\n";
    std::cout << "  Z boundary types: { top: ";
    // Print boundary types as strings for top and bottom
    string top_type_str = (top_boundary_type == BT::Dirichlet ? "Dirichlet" 
                          : (top_boundary_type == BT::Neumann ? "Neumann" : "Robin"));
    string bottom_type_str = (bottom_boundary_type == BT::Dirichlet ? "Dirichlet" 
                             : (bottom_boundary_type == BT::Neumann ? "Neumann" : "Robin"));
    std::cout << top_type_str << ", bottom: " << bottom_type_str << " }\n";
    std::cout << "  Z boundary params: { top: " << top_boundary_param 
              << ", bottom: " << bottom_boundary_param << " }\n";
    std::cout << "  Lateral boundary type: " 
              << (lateral_boundary_type == BT::Dirichlet ? "Dirichlet" 
                  : (lateral_boundary_type == BT::Neumann ? "Neumann" : "Robin"))
              << "\n";
    std::cout << "  Lateral boundary params: " << lateral_boundary_param << "\n";
    std::cout << "  Boundary epsilons: { Dirichlet: " << boundary_epsilon[0]
              << ", Neumann: " << boundary_epsilon[1] << ", Robin: " << boundary_epsilon[2] << " }\n";
    std::cout << "  Thermal conductivities: { source: " << k_source
              << ", medium: " << k_medium << " } W/(K*m)\n";
    std::cout << "  Ambient temperature: " << T_am << "\n";
    std::cout << "  Power density shape: (" << nz_heat << ", " << (ny+1) << ", " << (nx+1) << ")\n\n";
}

void GeometryConfig::initialize_heat_sources(bool padding) {
    // Determine array dimensions (add one extra row/col if padding enabled)
    int ny_size = ny + (padding ? 1 : 0);
    int nx_size = nx + (padding ? 1 : 0);
    power_density.resize(nz_heat);
    for(int iz = 0; iz < nz_heat; ++iz) {
        power_density[iz].assign(ny_size, vector<double>(nx_size, 0.0));
    }

    // Determine patch size for heat sources (5 mm in each lateral direction)
    int patch_size = static_cast<int>(std::lround(0.005 / xy_resolution));
    double power_density_value = 3.56e10; // W/m³ volumetric heat generation
    // Calculate starting indices for two patches at 25% and 75% positions in x and y
    int x_start1 = static_cast<int>(std::lround(0.25 * nx - patch_size / 2.0));
    int x_start2 = static_cast<int>(std::lround(0.75 * nx - patch_size / 2.0));
    int y_start1 = static_cast<int>(std::lround(0.25 * ny - patch_size / 2.0));
    int y_start2 = static_cast<int>(std::lround(0.75 * ny - patch_size / 2.0));
    vector<int> x_starts = {x_start1, x_start2};
    vector<int> y_starts = {y_start1, y_start2};
    std::cout << "x_starts, y_starts, patch_size: [" << x_start1 << ", " << x_start2 
              << "], [" << y_start1 << ", " << y_start2 << "], " << patch_size << "\n";
    // Fill the defined square patches in the heat source region
    for(int iy0 : y_starts) {
        for(int ix0 : x_starts) {
            for(int iz = 0; iz < nz_heat; ++iz) {
                int iy_end = std::min(ny, iy0 + patch_size);
                int ix_end = std::min(nx, ix0 + patch_size);
                for(int iy = iy0; iy < iy_end; ++iy) {
                    for(int ix = ix0; ix < ix_end; ++ix) {
                        power_density[iz][iy][ix] = power_density_value * xy_resolution * xy_resolution * z_resolution;
                    }
                }
            }
        }
    }
    if(padding) {
        // Copy the last row and column to the padded edge (to handle boundary indexing at ny or nx)
        int last_y = ny; // index of the new padded row
        int last_x = nx; // index of the new padded column
        for(int iz = 0; iz < nz_heat; ++iz) {
            // Copy last real row into padded row (for all x except padded column)
            for(int ix = 0; ix < nx; ++ix) {
                power_density[iz][last_y][ix] = power_density[iz][ny-1][ix];
            }
            // Copy last real column into padded column (for all y except padded row)
            for(int iy = 0; iy < ny; ++iy) {
                power_density[iz][iy][last_x] = power_density[iz][iy][nx-1];
            }
            // Fill the bottom-right corner of padding
            power_density[iz][last_y][last_x] = power_density[iz][ny-1][nx-1];
        }
    }
}

void GeometryConfig::precompute_conductance() {
    if(precompute) {
        return;  // already computed
    }
    // Prepare conductance_table with dimensions [nz_heat+2][ny][nx]
    int z_count = nz_heat + 2;
    conductance_table.resize(z_count);
    for(int iz = 0; iz < z_count; ++iz) {
        conductance_table[iz].assign(ny, vector<array<double,6>>(nx));
    }
    // Compute conductance for indices from bottom virtual layer (z_virtual1.first) to top virtual layer (z_virtual2.second)
    int start_iz = z_virtual1.first;
    int end_iz = z_virtual2.second;
    std::cout << "Precomputing conductance values..." << std::endl;
    for(int iz = start_iz; iz <= end_iz; ++iz) {
        for(int iy = 0; iy < ny; ++iy) {
            for(int ix = 0; ix < nx; ++ix) {
                array<double,6> g = compute_conductance_indices(iz, iy, ix);
                int table_index = iz - start_iz;
                conductance_table[table_index][iy][ix] = g;
            }
        }
    }
    precompute = true;
}

array<double,6> GeometryConfig::compute_conductance_indices(int iz, int iy, int ix) const {
    // Helper to get thermal conductivity k (W/m·K) at a given z-index
    auto get_k_at_index = [&](int z_idx) -> double {
        string region = get_region_by_z(z_idx);
        return (region == "heat_source") ? k_source : k_medium;
    };

    double k_center = get_k_at_index(iz);
    double dx = xy_resolution;
    double dy = xy_resolution;
    double dz = z_resolution;
    // Neighbor index shifts for six directions
    static const array<pair<string, array<int,3>>, 6> directions = {{
        {"+x", {0, 0, +1}},
        {"-x", {0, 0, -1}},
        {"+y", {0, +1, 0}},
        {"-y", {0, -1, 0}},
        {"+z", {+1, 0, 0}},
        {"-z", {-1, 0, 0}}
    }};
    array<double,6> conductance;
    for(size_t idx = 0; idx < directions.size(); ++idx) {
        int iz_n = iz + directions[idx].second[0];
        int iy_n = iy + directions[idx].second[1];
        int ix_n = ix + directions[idx].second[2];
        bool out_of_bounds = (ix_n < 0 || ix_n >= nx || iy_n < 0 || iy_n >= ny || iz_n < 0 || iz_n >= nz_total);
        double A, d;
        // Determine cross-sectional area A and distance d for this direction
        if(directions[idx].first == "+x" || directions[idx].first == "-x") {
            A = dy * dz;
            d = dx;
        } else if(directions[idx].first == "+y" || directions[idx].first == "-y") {
            A = dx * dz;
            d = dy;
        } else {
            A = dx * dy;
            d = dz;
        }
        double g_val;
        if(out_of_bounds) {
            if(directions[idx].first == "+x" || directions[idx].first == "-x" ||
               directions[idx].first == "+y" || directions[idx].first == "-y") {
                // Lateral neighbor out of bounds: treat as semi-infinite boundary (one-sided resistance)
                double r = (1.0 / k_center) * (d / A);
                g_val = 1.0 / r;
            } else {
                // Vertical neighbor out of domain (should not occur in precomputed range)
                g_val = 0.0;
            }
        } else {
            double k_neighbor = get_k_at_index(iz_n);
            // Thermal resistance r for center and neighbor in series
            double r = 0.5 * (1.0 / k_center + 1.0 / k_neighbor) * (d / A);
            g_val = 1.0 / r;
        }
        conductance[idx] = g_val;
    }
    return conductance;
}

string GeometryConfig::get_region_by_z(int z_index) const {
    if(z_index >= z_bottom.first && z_index <= z_bottom.second) {
        return "bottom";
    } else if(z_index >= z_virtual1.first && z_index <= z_virtual1.second) {
        return "virtual_bottom";
    } else if(z_index >= z_heat.first && z_index <= z_heat.second) {
        return "heat_source";
    } else if(z_index >= z_virtual2.first && z_index <= z_virtual2.second) {
        return "virtual_top";
    } else if(z_index >= z_top.first && z_index <= (z_top.second + 1)) {
        return "top";
    } else {
        return "out_of_domain";
    }
}

string GeometryConfig::get_region_by_coord(double z_coord) const {
    int z_index = static_cast<int>(std::floor(z_coord / z_resolution));
    return get_region_by_z(z_index);
}

bool GeometryConfig::is_near_boundary(const array<double,3>& pos,
                                      string& boundary_position,
                                      BoundaryType& boundary_type,
                                      double& boundary_param) const {
    double z = pos[0];
    // Top boundary proximity check
    double top_eps = boundary_epsilon[static_cast<int>(top_boundary_type)];
    if(z >= nz_total * z_resolution - top_eps) {
        boundary_position = "top";
        boundary_type = top_boundary_type;
        boundary_param = top_boundary_param;
        return true;
    }
    // Bottom boundary proximity check
    double bottom_eps = boundary_epsilon[static_cast<int>(bottom_boundary_type)];
    if(z <= bottom_eps) {
        boundary_position = "bottom";
        boundary_type = bottom_boundary_type;
        boundary_param = bottom_boundary_param;
        return true;
    }
    // Not near top or bottom
    boundary_position.clear();
    return false;
}

array<double,6> GeometryConfig::get_conductance(const array<double,3>& pos) const {
    // Compute grid indices from physical coordinates
    double z = pos[0], y = pos[1], x = pos[2];
    int ix = static_cast<int>(std::floor(x / xy_resolution));
    int iy = static_cast<int>(std::floor(y / xy_resolution));
    int iz = static_cast<int>(std::floor(z / z_resolution));
    // Use precomputed table if available and index is within its range
    if(precompute && ix >= 0 && ix < nx && iy >= 0 && iy < ny &&
       iz >= z_virtual1.first && iz <= z_virtual2.second) {
        int table_index = iz - z_virtual1.first;
        if(table_index >= 0 && table_index < static_cast<int>(conductance_table.size())) {
            return conductance_table[table_index][iy][ix];
        }
    }
    // Otherwise compute conductance on the fly
    return compute_conductance_indices(iz, iy, ix);
}


void GeometryConfig::load_power_density_from_file(const std::string& filename, bool padding) {
    int ny_size = ny + (padding ? 1 : 0);
    int nx_size = nx + (padding ? 1 : 0);

    power_density.resize(nz_heat);
    for (int iz = 0; iz < nz_heat; ++iz) {
        power_density[iz].resize(ny_size, std::vector<double>(nx_size, 0.0));
    }

    std::ifstream fin(filename, std::ios::binary);
    if (!fin) {
        throw std::runtime_error("Failed to open file: " + filename);
    }

    for (int iz = 0; iz < nz_heat; ++iz) {
        for (int iy = 0; iy < ny; ++iy) {
            for (int ix = 0; ix < nx; ++ix) {
                double val;
                fin.read(reinterpret_cast<char*>(&val), sizeof(double));
                if (!fin) {
                    throw std::runtime_error("Unexpected EOF or read error.");
                }
                power_density[iz][iy][ix] = val;
            }
        }
    }
    fin.close();

    if (padding) {
        int last_y = ny;
        int last_x = nx;
        for (int iz = 0; iz < nz_heat; ++iz) {
            for (int ix = 0; ix < nx; ++ix) {
                power_density[iz][last_y][ix] = power_density[iz][ny - 1][ix];
            }
            for (int iy = 0; iy < ny; ++iy) {
                power_density[iz][iy][last_x] = power_density[iz][iy][nx - 1];
            }
            power_density[iz][last_y][last_x] = power_density[iz][ny - 1][nx - 1];
        }
    }

    std::cout << "[GeometryConfig] Loaded power density from: " << filename << "\n";
}

void GeometryConfig::scale_power_density(double factor) {
    if (factor == 1.0) {
        return;
    }
    for (auto& layer : power_density) {
        for (auto& row : layer) {
            for (double& value : row) {
                value *= factor;
            }
        }
    }
    std::cout << "[GeometryConfig] Applied power density scale: " << factor << "\n";
}


namespace {
void load_temperature_field_impl(std::vector<std::vector<std::vector<double>>>& field,
                                 int nz_heat, int ny, int nx,
                                 const std::string& filename,
                                 double temperature_offset,
                                 const std::string& label) {
    field.resize(nz_heat);
    for (int iz = 0; iz < nz_heat; ++iz) {
        field[iz].resize(ny);
        for (int iy = 0; iy < ny; ++iy) {
            field[iz][iy].resize(nx, 0.0);
        }
    }

    std::ifstream fin(filename, std::ios::binary);
    if (!fin) {
        throw std::runtime_error("Failed to open " + label + " temperature field file: " + filename);
    }

    for (int iz = 0; iz < nz_heat; ++iz) {
        for (int iy = 0; iy < ny; ++iy) {
            for (int ix = 0; ix < nx; ++ix) {
                double val;
                fin.read(reinterpret_cast<char*>(&val), sizeof(double));
                if (!fin) {
                    throw std::runtime_error("Unexpected EOF or read error in " + label + " temperature field.");
                }
                field[iz][iy][ix] = val + temperature_offset;
            }
        }
    }
    fin.close();
    std::cout << "[GeometryConfig] Loaded " << label << " temperature field from: " << filename
              << " (offset " << temperature_offset << ")\n";
}

double temperature_at_impl(const std::vector<std::vector<std::vector<double>>>& field,
                           int nz_heat, int ny, int nx,
                           double z_resolution, double xy_resolution,
                           const std::pair<int,int>& z_heat,
                           const std::array<double, 3>& pos,
                           const std::string& label) {
    double z = pos[0], y = pos[1], x = pos[2];
    int iz = static_cast<int>(std::floor(z / z_resolution)) - z_heat.first;
    int iy = static_cast<int>(std::floor(y / xy_resolution));
    int ix = static_cast<int>(std::floor(x / xy_resolution));

    if (field.empty()) {
        throw std::runtime_error(label + " temperature field is not loaded");
    }
    if (iz < 0 || iz >= nz_heat || iy < 0 || iy >= ny || ix < 0 || ix >= nx) {
        std::cout << z << " " << y << " " << x << std::endl;
        std::cout << iz << " " << iy << " " << ix << std::endl;
        throw std::out_of_range("Physical position out of " + label + " temperature_field range");
    }
    return field[iz][iy][ix];
}
}

void GeometryConfig::load_prior_temperature_field_from_file(const std::string& filename, double temperature_offset) {
    load_temperature_field_impl(temperature_field, nz_heat, ny, nx, filename, temperature_offset, "prior");
}

void GeometryConfig::load_reference_temperature_field_from_file(const std::string& filename, double temperature_offset) {
    load_temperature_field_impl(reference_temperature_field, nz_heat, ny, nx, filename, temperature_offset, "reference");
}

void GeometryConfig::load_temperature_field_from_file(const std::string& filename, double temperature_offset) {
    load_prior_temperature_field_from_file(filename, temperature_offset);
    load_reference_temperature_field_from_file(filename, temperature_offset);
}

double GeometryConfig::get_prior_temperature_at(const std::array<double, 3>& pos) const {
    return temperature_at_impl(temperature_field, nz_heat, ny, nx, z_resolution, xy_resolution, z_heat, pos, "prior");
}

double GeometryConfig::get_reference_temperature_at(const std::array<double, 3>& pos) const {
    if (!reference_temperature_field.empty()) {
        return temperature_at_impl(reference_temperature_field, nz_heat, ny, nx, z_resolution, xy_resolution, z_heat, pos, "reference");
    }
    return get_prior_temperature_at(pos);
}

double GeometryConfig::get_temperature_at(const std::array<double, 3>& pos) const {
    return get_reference_temperature_at(pos);
}
