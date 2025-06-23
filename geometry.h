#ifndef GEOMETRY_H
#define GEOMETRY_H

#include <vector>
#include <array>
#include <tuple>
#include <unordered_map>
#include <string>

class GeometryConfig {
public:
    double T_am;
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

    std::unordered_map<std::string, std::string> z_boundary_types;
    std::unordered_map<std::string, double> z_boundary_params;
    std::string lateral_boundary_type;
    double lateral_boundary_params;
    std::unordered_map<std::string,double> boundary_epsilon;

    std::vector<std::vector<std::vector<double>>> power_density;

    GeometryConfig();

    std::string get_region_by_z(int z_index) const;
    std::string get_region_by_coord(double z_coord) const;
    std::tuple<std::string,std::string,double> is_near_boundary(const std::array<double,3>& pos) const;
    std::unordered_map<std::string,double> get_conductance(const std::array<double,3>& pos_meter) const;
};

#endif // GEOMETRY_H
