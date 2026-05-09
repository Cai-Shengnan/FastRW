cmake_minimum_required(VERSION 3.14)
project(ResRW LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Threads REQUIRED)

add_executable(random_walker
    src/main.cpp
    src/geometry.cpp
    src/simulation_config.cpp
    src/walker.cpp
)

target_include_directories(random_walker PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/third_party/nlohmann
)

target_link_libraries(random_walker PRIVATE Threads::Threads)

if(APPLE)
    enable_language(OBJCXX)

    add_executable(random_walker_metal
        src/main_metal.cpp
        src/geometry.cpp
        src/simulation_config.cpp
        src/walker_metal.mm
    )

    target_include_directories(random_walker_metal PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_SOURCE_DIR}/third_party/nlohmann
    )

    target_compile_options(random_walker_metal PRIVATE
        "$<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>"
    )

    target_link_libraries(random_walker_metal PRIVATE
        Threads::Threads
        "-framework Foundation"
        "-framework Metal"
    )
endif()
