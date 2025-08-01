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
        "RR_00084_power.bin"
    );
    geom.load_temperature_field_from_file("RR_00084_temp.bin");
    // Initialize RandomWalker with the geometry
    // Use smaller max_steps to keep example runtime short
    RandomWalker walker(geom);
    // Define several points inside the heat source region
    std::vector<Position> points = {};

    for (int i = 0; i < 1; i++){
        double ix = geom.xy_resolution * i + 5e-3;
        for (int j = 0; j < 1; j++){
            double iy = geom.xy_resolution * j + 5e-3;
            Position cur_p = Position({5.5e-4, ix, iy});
            points.push_back(cur_p);
        }
    }
    
    std::cout<< "Total Point Number = " << points.size() << std::endl;


    auto stats = walker.simulate_temperature_multi(points, 1000);
    for(size_t i = 0; i < stats.size(); ++i) {
        const auto& s = stats[i];
        const auto& p = points[i];
        std::cout << "Point " << i << ": direct_mean=" << s.normal_mean << " GT = " << geom.get_temperature_at(p)
                 << std::endl;
    }



    return 0;
}
