cmake_minimum_required(VERSION 3.14)
project(RandomWalker)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ✅ 显式开启 pthread 支持
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")

# === 1. Eigen ===
include_directories(${CMAKE_SOURCE_DIR}/eigen-3.4.0)

# === 2. OSQP ===
include_directories(${CMAKE_SOURCE_DIR}/osqp/include)
link_directories(${CMAKE_SOURCE_DIR}/osqp/build/out)

# === 3. OSQP-Eigen ===
include_directories(${CMAKE_SOURCE_DIR}/osqp-eigen/include)
link_directories(${CMAKE_SOURCE_DIR}/osqp-eigen/build)

# === 4. Source ===
add_executable(random_walker main.cpp geometry.cpp walker.cpp)

# === 5. Link libraries ===
target_link_libraries(random_walker OsqpEigen osqp)
