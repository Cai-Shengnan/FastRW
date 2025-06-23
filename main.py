from walker import RandomWalker
from geomery import GeometryConfig


def main():
    geom = GeometryConfig(z_boundary_types=('Robin', 'Robin'),
                 z_boundary_params=(8700,8700),xy_resolution=2e-5,
                 z_resolution=2e-5)
    walker = RandomWalker(geom)



    res = walker.simulate_temperature([5.5e-4, 0.005, 0.005], N=1000)# z, y, x 我们取中间试试
    print(res)


if __name__ == "__main__":
    main()