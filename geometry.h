#ifndef GEOMETRY_CONFIG_H
#define GEOMETRY_CONFIG_H

#include <vector>
#include <array>
#include <string>
#include <utility>
#include <iostream>
#include <cmath>

class GeometryConfig {
public:
    // Boundary condition type for top/bottom boundaries
    enum class BoundaryType { Dirichlet = 0, Neumann = 1, Robin = 2 };

    // Constructor with default parameter values
    GeometryConfig(double x_size = 2e-2, double y_size = 2e-2,
                   double bottom_thickness = 5e-4,
                   double heat_source_thickness = 1e-4,
                   double top_thickness = 5e-4,
                   double xy_resolution = 1e-4,
                   double z_resolution = 2e-5,
                   BoundaryType top_boundary_type = BoundaryType::Robin,
                   BoundaryType bottom_boundary_type = BoundaryType::Dirichlet,
                   double top_boundary_param = 8700.0,
                   double bottom_boundary_param = 343.15,
                   BoundaryType lateral_boundary_type = BoundaryType::Neumann,
                   double lateral_boundary_param = 0.0,
                   double eps_dirichlet = 1e-8,
                   double eps_neumann = 1.5 * 5e-7,
                   double eps_robin = 1.5 * 5e-7);

    // Pre-compute conductance for relevant grid points (optional optimization)
    void precompute_conductance();

    // Determine region name by grid index in z-direction
    std::string get_region_by_z(int z_index) const;
    // Determine region name by a z coordinate (in meters)
    std::string get_region_by_coord(double z_coord) const;
    // Check if a given position is near the top or bottom boundary.
    // Returns true if near a boundary, and sets boundary_position ("top"/"bottom"), boundary_type, and boundary_param.
    bool is_near_boundary(const std::array<double,3>& pos,
                          std::string& boundary_position,
                          BoundaryType& boundary_type,
                          double& boundary_param) const;
    // Compute thermal conductance to neighboring cells at a given position (z, y, x in meters).
    // Returns an array of 6 conductance values in the order: [+x, -x, +y, -y, +z, -z].
    std::array<double,6> get_conductance(const std::array<double,3>& pos) const;

    // Public members (geometry parameters and data)
    double T_am;  // Ambient temperature (e.g., 20°C)
    double x_size, y_size;
    double bottom_thickness, heat_source_thickness, top_thickness;
    double virtual_layer_thickness;
    double xy_resolution, z_resolution;
    int nx, ny;
    int nz_bottom, nz_heat, nz_top, nz_virtual, nz_total;
    std::pair<int,int> z_bottom;
    std::pair<int,int> z_virtual1;
    std::pair<int,int> z_heat;
    std::pair<int,int> z_virtual2;
    std::pair<int,int> z_top;
    BoundaryType top_boundary_type;
    BoundaryType bottom_boundary_type;
    BoundaryType lateral_boundary_type;
    double top_boundary_param;
    double bottom_boundary_param;
    double lateral_boundary_param;
    // Small threshold distances for boundary detection (per boundary type)
    std::array<double,3> boundary_epsilon;
    // 3D array of volumetric heat power density (W/m^3) for the heat source region.
    // Dimensions: [nz_heat][ny+1][nx+1] (padded in y and x directions).
    std::vector<std::vector<std::vector<double>>> power_density;

private:
    // Compute conductance at a specific grid index (iz, iy, ix)
    std::array<double,6> compute_conductance_indices(int iz, int iy, int ix) const;
    // Initialize heat source distribution in the power_density array (with optional padding on edges)
    void initialize_heat_sources(bool padding);
    // Table for precomputed conductance values.
    // Indexing: [iz - z_virtual1.first][iy][ix] gives an array of 6 conductances for that cell.
    std::vector<std::vector<std::vector<std::array<double,6>>>> conductance_table;
    bool precompute;  // Flag indicating if conductance_table has been filled
};

#endif // GEOMETRY_CONFIG_H
