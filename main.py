from walker import RandomWalker
from geomery import GeometryConfig


def main():
    geom = GeometryConfig()
    walker = RandomWalker(geom)
    
    res = walker._simulate_single_path_wrapper([5.5e-4, 0.01, 0.01])
    # res = walker.simulate_temperature([5.5e-4, 0.01, 0.01], N=10) # z, y, x 我们取中间试试
    print(res)


if __name__ == "__main__":
    main()