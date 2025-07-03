#include <iostream>
#include "geometry.h"
#include "walker.h"

int main() {
    // Initialize geometry configuration with Robin boundary conditions on both top and bottom
    GeometryConfig geom(
        2e-2, 2e-2,
        5e-4, 1e-4, 5e-4,
        1e-4, 2e-5,
        GeometryConfig::BoundaryType::Robin,    // Top boundary type
        GeometryConfig::BoundaryType::Dirichlet,    // Bottom boundary type
        8700.0, 70.0                          // Top and bottom boundary parameters (e.g., h for Robin)
    );
    // Initialize RandomWalker with the geometry
    RandomWalker walker(geom);
    // Set starting position (z, y, x) in meters
    Position start_pos = {7.7e-4, 0.0149, 0.0007};
    // Run simulations (e.g., N=1000 paths) to estimate the temperature
    double result = walker.simulate_temperature(start_pos, 5000);
    std::cout << "Result (mean temperature): " << result << std::endl;
    return 0;
}
