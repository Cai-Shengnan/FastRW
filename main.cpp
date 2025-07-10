#include <iostream>
#include <numeric>
#include <vector>
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
    geom.load_temperature_field_from_file("/Users/zxwang/Documents/codes/ResRW/RR_0000_temp.bin");
    // Initialize RandomWalker with the geometry
    RandomWalker walker(geom);
    // Define several points inside the heat source region
    std::vector<Position> points = {
        {5.5e-4, 0.0051, 0.0151},
        {5.5e-4, 0.0101, 0.0101},
        {5.5e-4, 0.0151, 0.0051}
    };

    auto stats = walker.simulate_temperature_multi(points, 10);
    for(size_t i = 0; i < stats.size(); ++i) {
        const auto& s = stats[i];
        std::cout << "Point " << i << ": normal(" << s.normal_count << ") mean=" << s.normal_mean
                  << ", pass(" << s.pass_count << ") mean=" << s.pass_mean
                  << ", total(" << s.total_count << ") mean=" << s.total_mean << std::endl;
    }



    return 0;
}
