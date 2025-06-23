#ifndef GEOMETRY_H
#define GEOMETRY_H

#include <vector>
#include <string>
#include <unordered_map>
#include <cmath>

class GeometryConfig {
public:
    // Public members (matching Python attributes for accessibility)
    double T_am;  // Ambient temperature
    double x_size;
    double y_size;
    double bottom_thickness;
    double heat_source_thickness;
    double top_thickness;
    double virtual_layer_thickness;
    double xy_resolution;
    double z_resolution;
    int nx;
    int ny;
    int nz_bottom;
    int nz_heat;
    int nz_top;
    int nz_virtual;
    int nz_total;
    // Region index ranges (inclusive indices for each segment in z-direction)
    int z_bottom_start;
    int z_bottom_end;
    int z_virtual1_start;
    int z_virtual1_end;
    int z_heat_start;
    int z_heat_end;
    int z_virtual2_start;
    int z_virtual2_end;
    int z_top_start;
    int z_top_end;
    // Boundary conditions for top and bottom
    std::string top_boundary_type;
    std::string bottom_boundary_type;
    double top_boundary_param;
    double bottom_boundary_param;
    std::string lateral_boundary_type;
    double lateral_boundary_param;
    // Epsilon values for boundary proximity (by type)
    std::unordered_map<std::string,double> boundary_epsilon;
    // Power density 3D array (flattened) and its dimensions
    std::vector<double> power_density;
    int power_dim_x;
    int power_dim_y;
    int power_dim_z;
    bool precompute;

    // Constructor with default parameters (matching Python defaults)
    GeometryConfig(double x_size=2e-2, double y_size=2e-2,
                   double bottom_thickness=5e-4,
                   double heat_source_thickness=1e-4,
                   double top_thickness=5e-4,
                   double xy_resolution=1e-4,
                   double z_resolution=2e-5,
                   std::pair<std::string,std::string> z_boundary_types = {"Robin","Dirichlet"},
                   std::pair<double,double> z_boundary_params = {8700, 343.15},
                   std::string lateral_boundary_type = "Neumann",
                   double lateral_boundary_param = 0.0,
                   std::unordered_map<std::string,double> boundary_epsilon = {
                       {"Dirichlet", 1e-8},
                       {"Neumann", 1.36 * 5e-7},
                       {"Robin",    1.36 * 5e-7}
                   } );

    // Region and boundary queries
    std::string get_region_by_z(int z_index) const;
    std::string get_region_by_coord(double z_coord) const;
    std::tuple<std::string, std::string, double> is_near_boundary(const std::array<double,3>& pos) const;
    // Compute conductance (thermal conductance) to neighboring cells at a given position
    std::array<double,6> get_conductance(const std::array<double,3>& pos_meter);

private:
    // Internal helper functions
    std::array<double,6> compute_conductance_indices(int iz, int iy, int ix);
    void initialize_heat_sources(bool padding);
    inline double material_conductivity(int z_index) const;
};

#endif // GEOMETRY_H
