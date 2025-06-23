#include "geometry.h"
#include <algorithm>  // for std::min and std::max
#include <tuple>

GeometryConfig::GeometryConfig(double x_size_val, double y_size_val,
                               double bottom_thickness_val,
                               double heat_source_thickness_val,
                               double top_thickness_val,
                               double xy_resolution_val,
                               double z_resolution_val,
                               std::pair<std::string,std::string> z_boundary_types_val,
                               std::pair<double,double> z_boundary_params_val,
                               std::string lateral_boundary_type_val,
                               double lateral_boundary_param_val,
                               std::unordered_map<std::string,double> boundary_epsilon_val)
{
    // Assign geometry parameters
    T_am = 20.0;
    x_size = x_size_val;
    y_size = y_size_val;
    xy_resolution = xy_resolution_val;
    z_resolution = z_resolution_val;
    // Adjust bottom and top thickness by subtracting one z-resolution (matching Python logic)
    bottom_thickness = bottom_thickness_val - z_resolution;
    heat_source_thickness = heat_source_thickness_val;
    top_thickness = top_thickness_val - z_resolution;
    virtual_layer_thickness = z_resolution;
    // Calculate grid cell counts in each dimension
    nx = static_cast<int>(x_size / xy_resolution);
    ny = static_cast<int>(y_size / xy_resolution);
    nz_bottom   = static_cast<int>(bottom_thickness / z_resolution);
    nz_heat     = static_cast<int>(heat_source_thickness / z_resolution);
    nz_top      = static_cast<int>(top_thickness / z_resolution);
    nz_virtual  = static_cast<int>(virtual_layer_thickness / z_resolution);
    nz_total    = nz_bottom + 2 * nz_virtual + nz_heat + nz_top;
    // Define index ranges for each region (inclusive indices)
    z_bottom_start  = 0;
    z_bottom_end    = nz_bottom - 1;
    z_virtual1_start = z_bottom_end + 1;
    z_virtual1_end   = z_bottom_end + nz_virtual;
    z_heat_start    = z_virtual1_end + 1;
    z_heat_end      = z_virtual1_end + nz_heat;
    z_virtual2_start = z_heat_end + 1;
    z_virtual2_end   = z_heat_end + nz_virtual;
    z_top_start     = z_virtual2_end + 1;
    z_top_end       = nz_total - 1;
    // Boundary condition types and parameters
    top_boundary_type = z_boundary_types_val.first;
    bottom_boundary_type = z_boundary_types_val.second;
    top_boundary_param = z_boundary_params_val.first;
    bottom_boundary_param = z_boundary_params_val.second;
    lateral_boundary_type = lateral_boundary_type_val;
    lateral_boundary_param = lateral_boundary_param_val;
    boundary_epsilon = boundary_epsilon_val;
    // Initialize the power density array (with heat sources)
    initialize_heat_sources(true);
    precompute = false;
}

// Helper: determine thermal conductivity `k` at a given z-index (based on region)
inline double GeometryConfig::material_conductivity(int z_index) const {
    std::string region = get_region_by_z(z_index);
    return (region == "heat_source") ? 125.0 : 395.0;
}

void GeometryConfig::initialize_heat_sources(bool padding) {
    // Set up power_density array dimensions
    power_dim_z = nz_heat;
    int base_ny = ny;
    int base_nx = nx;
    int alloc_y = base_ny;
    int alloc_x = base_nx;
    if (padding) {
        alloc_y = base_ny + 1;
        alloc_x = base_nx + 1;
    }
    power_dim_y = alloc_y;
    power_dim_x = alloc_x;
    power_density.assign(nz_heat * power_dim_y * power_dim_x, 0.0);
    // Define a square heat patch of 5 mm x 5 mm in the heat source layer
    int patch_size = static_cast<int>(0.005 / xy_resolution);
    double power_density_value = 0;  // W/m³ (power density)
    // Compute starting indices for two patches (at 25% and 75% positions in X and Y)
    int x_start1 = static_cast<int>(0.25 * base_nx - patch_size / 2.0);
    int x_start2 = static_cast<int>(0.75 * base_nx - patch_size / 2.0);
    int y_start1 = static_cast<int>(0.25 * base_ny - patch_size / 2.0);
    int y_start2 = static_cast<int>(0.75 * base_ny - patch_size / 2.0);
    std::vector<int> x_starts = {x_start1, x_start2};
    std::vector<int> y_starts = {y_start1, y_start2};
    double cell_volume = xy_resolution * xy_resolution * z_resolution;
    // Fill the patch areas in all heat source layers
    for (int z = 0; z < nz_heat; ++z) {
        for (int y0 : y_starts) {
            if (y0 < 0 || y0 + patch_size > base_ny) continue;
            for (int x0 : x_starts) {
                if (x0 < 0 || x0 + patch_size > base_nx) continue;
                for (int yy = y0; yy < y0 + patch_size; ++yy) {
                    for (int xx = x0; xx < x0 + patch_size; ++xx) {
                        // Compute linear index and assign power density (W per cell)
                        size_t index = (static_cast<size_t>(z) * power_dim_y + yy) * power_dim_x + xx;
                        power_density[index] = power_density_value * cell_volume;
                    }
                }
            }
        }
    }
    if (padding) {
        // Duplicate the last row and column to pad the array by one (to handle boundary indexing)
        int last_y = base_ny - 1;
        int last_x = base_nx - 1;
        for (int z = 0; z < nz_heat; ++z) {
            // Copy last row (y = last_y) into new padded row (y = base_ny)
            for (int xx = 0; xx < base_nx; ++xx) {
                size_t orig_idx = (static_cast<size_t>(z) * power_dim_y + last_y) * power_dim_x + xx;
                size_t pad_idx  = (static_cast<size_t>(z) * power_dim_y + base_ny) * power_dim_x + xx;
                power_density[pad_idx] = power_density[orig_idx];
            }
            // Copy last column (x = last_x) into new padded column (x = base_nx)
            for (int yy = 0; yy < base_ny; ++yy) {
                size_t orig_idx = (static_cast<size_t>(z) * power_dim_y + yy) * power_dim_x + last_x;
                size_t pad_idx  = (static_cast<size_t>(z) * power_dim_y + yy) * power_dim_x + base_nx;
                power_density[pad_idx] = power_density[orig_idx];
            }
            // Copy the bottom-right corner cell into the new corner (y = base_ny, x = base_nx)
            size_t orig_corner_idx = (static_cast<size_t>(z) * power_dim_y + last_y) * power_dim_x + last_x;
            size_t pad_corner_idx  = (static_cast<size_t>(z) * power_dim_y + base_ny) * power_dim_x + base_nx;
            power_density[pad_corner_idx] = power_density[orig_corner_idx];
        }
    }
}

std::string GeometryConfig::get_region_by_z(int z_index) const {
    if (z_index >= z_bottom_start && z_index <= z_bottom_end) {
        return "bottom";
    } else if (z_index >= z_virtual1_start && z_index <= z_virtual1_end) {
        return "virtual_bottom";
    } else if (z_index >= z_heat_start && z_index <= z_heat_end) {
        return "heat_source";
    } else if (z_index >= z_virtual2_start && z_index <= z_virtual2_end) {
        return "virtual_top";
    } else if (z_index >= z_top_start && z_index <= (z_top_end + 1)) {
        // Include z_top_end + 1 as part of "top" region (mirroring Python logic)
        return "top";
    } else {
        return "out_of_domain";
    }
}

std::string GeometryConfig::get_region_by_coord(double z_coord) const {
    if (z_coord < 0.0) {
        return "out_of_domain";
    }
    int z_index = static_cast<int>(std::floor(z_coord / z_resolution));
    return get_region_by_z(z_index);
}

std::tuple<std::string, std::string, double> GeometryConfig::is_near_boundary(const std::array<double,3>& pos) const {
    double z = pos[0];
    // Check proximity to top boundary
    double eps_top = boundary_epsilon.at(top_boundary_type);
    double eps_bottom = boundary_epsilon.at(bottom_boundary_type);
    if (z >= nz_total * z_resolution - eps_top) {
        // Near the top boundary
        return { "top", top_boundary_type, top_boundary_param };
    }
    if (z <= eps_bottom) {
        // Near the bottom boundary
        return { "bottom", bottom_boundary_type, bottom_boundary_param };
    }
    // Not near top or bottom
    return { "", "", 0.0 };
}

std::array<double,6> GeometryConfig::get_conductance(const std::array<double,3>& pos_meter) {
    // Compute nearest grid indices for the given physical position
    double z = pos_meter[0];
    double y = pos_meter[1];
    double x = pos_meter[2];
    int ix = static_cast<int>(std::floor(x / xy_resolution));
    int iy = static_cast<int>(std::floor(y / xy_resolution));
    int iz = static_cast<int>(std::floor(z / z_resolution));
    // Always compute on the fly (precomputation not enabled by default)
    return compute_conductance_indices(iz, iy, ix);
}

std::array<double,6> GeometryConfig::compute_conductance_indices(int iz, int iy, int ix) {
    double k_center = material_conductivity(iz);
    double dx = xy_resolution;
    double dy = xy_resolution;
    double dz = z_resolution;
    std::array<double,6> g_vals;
    // Neighbor index offsets for +x, -x, +y, -y, +z, -z directions
    static const std::array<std::array<int,3>,6> offsets = {{
        { 0,  0, +1},  // +x
        { 0,  0, -1},  // -x
        { 0, +1,  0},  // +y
        { 0, -1,  0},  // -y
        { +1, 0,  0},  // +z
        { -1, 0,  0}   // -z
    }};
    for (int i = 0; i < 6; ++i) {
        int iz_n = iz + offsets[i][0];
        int iy_n = iy + offsets[i][1];
        int ix_n = ix + offsets[i][2];
        bool out_of_bounds = (ix_n < 0 || ix_n >= nx ||
                               iy_n < 0 || iy_n >= ny ||
                               iz_n < 0 || iz_n >= nz_total);
        // Determine area A and distance d for this direction
        double A, d;
        if (i == 0 || i == 1) {        // ±x direction
            A = dy * dz;
            d = dx;
        } else if (i == 2 || i == 3) { // ±y direction
            A = dx * dz;
            d = dy;
        } else {                      // ±z direction
            A = dx * dy;
            d = dz;
        }
        double g;
        if (out_of_bounds) {
            if (i <= 3) {
                // Lateral out-of-bound (Neumann boundary): treat as symmetric boundary
                double R = (1.0 / k_center) * (d / A);
                g = (R == 0.0 ? 0.0 : 1.0 / R);
            } else {
                // Out-of-domain in z-direction (top/bottom beyond domain): no conduction
                g = 0.0;
            }
        } else {
            // Neighbor within domain
            double k_neighbor = material_conductivity(iz_n);
            double R = 0.5 * ((1.0 / k_center) + (1.0 / k_neighbor)) * (d / A);
            g = (R == 0.0 ? 0.0 : 1.0 / R);
        }
        g_vals[i] = g;
    }
    return g_vals;
}
