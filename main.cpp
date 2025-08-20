#include <iostream>
#include <fstream>
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
        "/Users/zxwang/Documents/codes/ResRW/date_2026_comsol_data/4 cores/coarse mesh temp/testcase3_power.bin"
    );
    geom.load_temperature_field_from_file("/Users/zxwang/Documents/codes/ResRW/date_2026_comsol_data/4 cores/coarse mesh temp/testcase3_temp.bin");
    // Initialize RandomWalker with the geometry
    // Use smaller max_steps to keep example runtime short
    RandomWalker walker(geom);
    // Define several points inside the heat source region
    std::vector<Position> points = {};

    for (int i = 0; i < 1; i++){
        double ix = geom.xy_resolution * i * 10 + 15e-3;
        for (int j = 0; j < 1; j++){
            double iy = geom.xy_resolution * j * 10 + 10e-3;
            Position cur_p = Position({5.5e-4, ix, iy});
            points.push_back(cur_p);
        }
    }
    
    std::cout<< "Total Point Number = " << points.size() << std::endl;


    auto stats = walker.simulate_temperature_multi(points, 1000);
    // Create and open CSV file for saving results
    std::ofstream csv_file("FastRw.csv");
    // Write CSV header
    csv_file << "Point,X,Y,Z,Normal_Mean,GT_Temperature,Error,Avg_Steps\n";

    geom.load_temperature_field_from_file("/Users/zxwang/Documents/codes/ResRW/date_2026_comsol_data/4 cores/fine mesh temp/testcase3_temp.bin");
    for(size_t i = 0; i < stats.size(); ++i) {
        const auto& s = stats[i];
        const auto& p = points[i];
        std::cout << "Point " << i 
                  << ": direct_mean=" << s.normal_mean +273.15
                  << " GT = " << geom.get_temperature_at(p) + 273.15
                  << " avg_steps=" << s.avg_steps
                  << std::endl;

        // Write to CSV file
        double gt_temp = geom.get_temperature_at(p);
        double error = s.normal_mean - gt_temp;
        csv_file << i << "," 
                 << p[2] << "," << p[1] << "," << p[0] << ","
                 << s.normal_mean << "," << gt_temp << "," << error << ","
                 << s.avg_steps << "\n";
    }
    csv_file.close();
    std::cout << "Results saved to simulation_results.csv" << std::endl;


    return 0;
}
