#include "walker.h"
#include "geometry.h"
#include <iostream>

int main(){
    GeometryConfig geom;
    RandomWalker walker(geom);
    std::array<double,3> point{5.5e-4, 0.005, 0.005};
    double res = walker.simulate_temperature(point, 1000);
    std::cout << res << std::endl;
    return 0;
}
