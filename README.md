# ResRW

This repository contains a C++ port of the original Python simulation.

## Building the C++ version

The code uses C++11 features such as `std::array` and `std::tuple`. Make sure
that you compile with at least C++11 support and include all source files.

```bash
g++ -std=c++11 main.cpp geometry.cpp walker.cpp -o main
```

Running `./main` will print the temperature estimate for the sample point used
in `main.cpp`.

