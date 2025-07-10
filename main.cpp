#include <iostream>
#include <numeric>
#include "geometry.h"
#include "walker.h"

int main() {
    // Initialize geometry configuration with Robin boundary conditions on both top and bottom
    GeometryConfig geom(
        2e-2, 2e-2,
        5e-4, 1e-4, 5e-4,
        2e-4, 2e-5,
        GeometryConfig::BoundaryType::Robin,    // Top boundary type
        GeometryConfig::BoundaryType::Robin,    // Bottom boundary type
        8700.0, 8700.0,                          // Top and bottom boundary parameters (e.g., h for Robin)
        GeometryConfig::BoundaryType::Neumann,
        0.0,
        1e-8, 1.5 * 5e-7, 1.5 * 5e-7,
        "/Users/zxwang/Documents/codes/ResRW/RR_0000_power.bin"
    );
    geom.load_temperature_field_from_file("/Users/zxwang/Documents/codes/ResRW/RR_00000_temp.bin");
    // Initialize RandomWalker with the geometry
    RandomWalker walker(geom);
    // Set starting position (z, y, x) in meters
    Position start_pos = {5.5e-4, 0.005, 0.015};
    // Run simulations (e.g., N=1000 paths) to estimate the temperature
    double result = walker.simulate_temperature(start_pos, 1000);
    std::cout << "Result (mean temperature): " << result << std::endl;



    return 0;
}
