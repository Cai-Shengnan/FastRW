#ifndef WALKER_H
#define WALKER_H

#include "geometry.h"
#include <array>
#include <vector>

class RandomWalker {
public:
    explicit RandomWalker(const GeometryConfig& geom);
    double simulate_temperature(const std::array<double,3>& x0_meter, int N=1000);
private:
    const GeometryConfig& geom;
    double simulate_single_path(const std::array<double,3>& x0_meter);
    std::array<double,3> step_wos(const std::array<double,3>& pos, double radius, bool& hit);
    std::array<double,3> step_wog(const std::array<double,3>& pos);
    std::array<double,3> reflect(const std::array<double,3>& pos, bool& hit) const;
    double get_heat_reward(const std::array<double,3>& pos);
    double get_gt(const std::array<double,3>& pos);
    double estimate_local_time_increment(const std::string& bc_type);
};

#endif // WALKER_H
