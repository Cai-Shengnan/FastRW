#include "walker.h"
#include "geometry.h"
#include <iostream>

int main() {
    // Initialize geometry configuration (using the same parameters as main.py)
    GeometryConfig geom(
        2e-2, 2e-2,                  // x_size, y_size (0.02 m each)
        5e-4, 1e-4, 5e-4,            // bottom_thickness, heat_source_thickness, top_thickness
        2e-5, 2e-5,                  // xy_resolution, z_resolution (both 2e-5 m)
        {"Robin", "Robin"},          // top and bottom boundary types
        {8700.0, 8700.0},            // top and bottom boundary parameters
        "Neumann", 0.0               // lateral boundary type and parameter
    );
    RandomWalker walker(&geom);
    // Starting position: [z, y, x] in meters (same as used in main.py)
    std::array<double,3> start_pos = { 5.5e-4, 0.005, 0.005 };
    // Simulate N=1000 random walk paths and print the average temperature result
    double result = walker.simulate_temperature(start_pos, 100);
    std::cout << result << std::endl;
    return 0;
}
