from walker import RandomWalker
from geomery import GeometryConfig


def main():
    geom = GeometryConfig(z_boundary_types=('Dirichlet', 'Dirichlet'),
                 z_boundary_params=(70,70),xy_resolution=5e-6,
                 z_resolution=5e-6)
    walker = RandomWalker(geom)
    sum = 0
    for i in range(100):

        res = walker.simulate_temperature([5.5e-4, 0.005, 0.005], N=100)# z, y, x 我们取中间试试

        sum += res
        print(res, sum/(i+1))


if __name__ == "__main__":
    main()