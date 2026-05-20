#include "walker_metal.h"

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <string>

#include "json.hpp"

using json = nlohmann::json;

namespace {
constexpr int kTailModeGt = 0;
constexpr int kTailModeNone = 1;
constexpr int kRobinModeCurrent = 0;
constexpr int kRobinModeEvent = 1;
constexpr int kRobinModeHit = 2;
constexpr int kDiagnosticStride = 28;
constexpr int kMaxPassesPerPath = 1024;

struct MetalPassRecordHost {
    int target_index;
    float t_sum;
    float e_hat;
    int step_count;
    int record_index;
};

static_assert(sizeof(MetalPassRecordHost) == 20,
              "MetalPassRecordHost must match the Metal PassRecord layout.");

struct MetalGeometryHost {
    int nx;
    int ny;
    int nz_heat;
    int nz_total;

    int z_bottom_start;
    int z_bottom_end;
    int z_virtual1_start;
    int z_virtual1_end;
    int z_heat_start;
    int z_heat_end;
    int z_virtual2_start;
    int z_virtual2_end;
    int z_top_start;
    int z_top_end;

    float x_size;
    float y_size;
    float xy_resolution;
    float z_resolution;
    float T_am;
    float k_source;
    float k_medium;

    int top_boundary_type;
    int bottom_boundary_type;
    int lateral_boundary_type;
    float top_boundary_param;
    float bottom_boundary_param;
    float lateral_boundary_param;
    float eps_dirichlet;
    float eps_neumann;
    float eps_robin;

    int max_steps;
    float cutoff_weight;
    float delta_x;
    int power_nx;
    int power_ny;
    int use_tail_correction;
    int tail_mode;
    int robin_local_time_mode;
    int point_count;
    int samples_per_point;
    unsigned int seed;
};

constexpr const char* kMetalSource = R"MSL(
#include <metal_stdlib>
using namespace metal;

constant int REGION_BOTTOM = 0;
constant int REGION_VIRTUAL_BOTTOM = 1;
constant int REGION_HEAT = 2;
constant int REGION_VIRTUAL_TOP = 3;
constant int REGION_TOP = 4;
constant int REGION_OUT = 5;

constant int BC_DIRICHLET = 0;
constant int BC_NEUMANN = 1;
constant int BC_ROBIN = 2;

	constant int BC_POS_TOP = 0;
	constant int BC_POS_BOTTOM = 1;
	constant int TAIL_MODE_GT = 0;
	constant int TAIL_MODE_NONE = 1;
		constant int ROBIN_MODE_CURRENT = 0;
		constant int ROBIN_MODE_EVENT = 1;
		constant int ROBIN_MODE_HIT = 2;
		constant int DIAG_STRIDE = 28;
		constant int MAX_PASS_RECORDS_PER_PATH = 1024;

constant float TWO_PI = 6.28318530717958647692f;

struct MetalGeometry {
    int nx;
    int ny;
    int nz_heat;
    int nz_total;

    int z_bottom_start;
    int z_bottom_end;
    int z_virtual1_start;
    int z_virtual1_end;
    int z_heat_start;
    int z_heat_end;
    int z_virtual2_start;
    int z_virtual2_end;
    int z_top_start;
    int z_top_end;

    float x_size;
    float y_size;
    float xy_resolution;
    float z_resolution;
    float T_am;
    float k_source;
    float k_medium;

    int top_boundary_type;
    int bottom_boundary_type;
    int lateral_boundary_type;
    float top_boundary_param;
    float bottom_boundary_param;
    float lateral_boundary_param;
    float eps_dirichlet;
    float eps_neumann;
    float eps_robin;

    int max_steps;
    float cutoff_weight;
    float delta_x;
	    int power_nx;
	    int power_ny;
	    int use_tail_correction;
	    int tail_mode;
	    int robin_local_time_mode;
	    int point_count;
	    int samples_per_point;
	    uint seed;
};

struct PassRecord {
    int target_index;
    float t_sum;
    float e_hat;
    int step_count;
    int record_index;
};

struct PathState {
    float z;
    float y;
    float x;
    float T0;
    float T1;
    float T2;
    float T3;
    float C0;
    float C1;
    float C2;
    float C3;
    float T0_unweighted;
    float C0_unweighted;
    float heat_e_hat_sum;
    float C_heat_e_hat_sum;
    float e_hat;
    float log_e_hat;
    float log_e_hat_compensation;
	    int near_robin;
	    int hit_robin;
	    int total_near_robin;
	    int total_hit_robin;
	    int cutoff_count;
	    int step_count;
	    bool in_robin;
	    float robin_parameter;
	    int robin_position;
	    int top_near_robin;
	    int top_hit_robin;
	    int bottom_near_robin;
	    int bottom_hit_robin;
	    float top_local_time;
	    float bottom_local_time;
	    float top_T3;
	    float bottom_T3;
	    float robin_log_decay;
	    float tail_e_hat;
	    float tail_temperature;
	    int heat_visit_count;
	    int heat_reward_nonzero_count;
	    int heat_pending_robin_count;
	    int virtual_top_visit_count;
	    int virtual_bottom_visit_count;
	    float heat_pending_robin_unweighted_reward;
	    uint rng;
	};

inline uint pcg_hash(uint input) {
    uint state = input * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

inline uint next_u32(thread uint& state) {
    state += 0x9e3779b9u;
    return pcg_hash(state);
}

inline float rand01(thread uint& state) {
    uint bits = next_u32(state) >> 8;
    return (static_cast<float>(bits) + 0.5f) * (1.0f / 16777216.0f);
}

inline void add_compensated(thread float& sum, thread float& compensation, float value) {
    float y = value - compensation;
    float t = sum + y;
    compensation = (t - sum) - y;
    sum = t;
}

inline int region_by_z(constant MetalGeometry& g, int z_index) {
    if (z_index >= g.z_bottom_start && z_index <= g.z_bottom_end) return REGION_BOTTOM;
    if (z_index >= g.z_virtual1_start && z_index <= g.z_virtual1_end) return REGION_VIRTUAL_BOTTOM;
    if (z_index >= g.z_heat_start && z_index <= g.z_heat_end) return REGION_HEAT;
    if (z_index >= g.z_virtual2_start && z_index <= g.z_virtual2_end) return REGION_VIRTUAL_TOP;
    if (z_index >= g.z_top_start && z_index <= (g.z_top_end + 1)) return REGION_TOP;
    return REGION_OUT;
}

inline int region_by_coord(constant MetalGeometry& g, float z_coord) {
    return region_by_z(g, static_cast<int>(floor(z_coord / g.z_resolution)));
}

inline float boundary_epsilon(constant MetalGeometry& g, int boundary_type) {
    if (boundary_type == BC_DIRICHLET) return g.eps_dirichlet;
    if (boundary_type == BC_NEUMANN) return g.eps_neumann;
    return g.eps_robin;
}

inline float k_at_index(constant MetalGeometry& g, int z_index) {
    return region_by_z(g, z_index) == REGION_HEAT ? g.k_source : g.k_medium;
}

inline bool is_near_boundary(
    constant MetalGeometry& g,
    float z,
    thread int& bc_pos,
    thread int& bc_type,
    thread float& bc_param
) {
    float top_eps = boundary_epsilon(g, g.top_boundary_type);
    if (z >= static_cast<float>(g.nz_total) * g.z_resolution - top_eps) {
        bc_pos = BC_POS_TOP;
        bc_type = g.top_boundary_type;
        bc_param = g.top_boundary_param;
        return true;
    }

    float bottom_eps = boundary_epsilon(g, g.bottom_boundary_type);
    if (z <= bottom_eps) {
        bc_pos = BC_POS_BOTTOM;
        bc_type = g.bottom_boundary_type;
        bc_param = g.bottom_boundary_param;
        return true;
    }

    return false;
}

inline void conductance_one(
    constant MetalGeometry& g,
    int iz,
    int iy,
    int ix,
    int dz_i,
    int dy_i,
    int dx_i,
    float area,
    float dist,
    bool vertical,
    thread float& out
) {
    int iz_n = iz + dz_i;
    int iy_n = iy + dy_i;
    int ix_n = ix + dx_i;
    bool out_of_bounds = (ix_n < 0 || ix_n >= g.nx ||
                          iy_n < 0 || iy_n >= g.ny ||
                          iz_n < 0 || iz_n >= g.nz_total);
    float k_center = k_at_index(g, iz);
    if (out_of_bounds) {
        if (vertical) {
            out = 0.0f;
        } else {
            float r = (1.0f / k_center) * (dist / area);
            out = 1.0f / r;
        }
        return;
    }

    float k_neighbor = k_at_index(g, iz_n);
    float r = 0.5f * (1.0f / k_center + 1.0f / k_neighbor) * (dist / area);
    out = 1.0f / r;
}

inline void get_conductance(constant MetalGeometry& g, int iz, int iy, int ix, thread float out[6]) {
    float dx = g.xy_resolution;
    float dy = g.xy_resolution;
    float dz = g.z_resolution;

    conductance_one(g, iz, iy, ix, 0, 0, +1, dy * dz, dx, false, out[0]);
    conductance_one(g, iz, iy, ix, 0, 0, -1, dy * dz, dx, false, out[1]);
    conductance_one(g, iz, iy, ix, 0, +1, 0, dx * dz, dy, false, out[2]);
    conductance_one(g, iz, iy, ix, 0, -1, 0, dx * dz, dy, false, out[3]);
    conductance_one(g, iz, iy, ix, +1, 0, 0, dx * dy, dz, true, out[4]);
    conductance_one(g, iz, iy, ix, -1, 0, 0, dx * dy, dz, true, out[5]);
}

inline float get_gt(constant MetalGeometry& g, int iz, int iy, int ix) {
    float vals[6];
    get_conductance(g, iz, iy, ix, vals);
    return vals[0] + vals[1] + vals[2] + vals[3] + vals[4] + vals[5];
}

inline float get_power_density(constant MetalGeometry& g, device const float* power, int iz, int iy, int ix) {
    if (iz < 0 || iz >= g.nz_heat || iy < 0 || iy >= g.power_ny || ix < 0 || ix >= g.power_nx) {
        return 0.0f;
    }
    uint idx = static_cast<uint>(iz) * static_cast<uint>(g.power_ny) * static_cast<uint>(g.power_nx)
             + static_cast<uint>(iy) * static_cast<uint>(g.power_nx)
             + static_cast<uint>(ix);
    return power[idx];
}

inline float get_temperature_at(constant MetalGeometry& g, device const float* temp, int iz, int iy, int ix) {
    if (iz < 0 || iz >= g.nz_heat || iy < 0 || iy >= g.ny || ix < 0 || ix >= g.nx) {
        return 0.0f;
    }
    uint idx = static_cast<uint>(iz) * static_cast<uint>(g.ny) * static_cast<uint>(g.nx)
             + static_cast<uint>(iy) * static_cast<uint>(g.nx)
             + static_cast<uint>(ix);
    return temp[idx];
}

inline float get_tail_temperature_at(constant MetalGeometry& g, device const float* temp, int iz, int iy, int ix) {
    if (iz < 0 || iz >= g.nz_heat) {
        return 0.0f;
    }
    int iy_clamped = max(0, min(iy, g.ny - 1));
    int ix_clamped = max(0, min(ix, g.nx - 1));
    uint idx = static_cast<uint>(iz) * static_cast<uint>(g.ny) * static_cast<uint>(g.nx)
             + static_cast<uint>(iy_clamped) * static_cast<uint>(g.nx)
             + static_cast<uint>(ix_clamped);
    return temp[idx];
}

inline float estimate_local_time_increment(constant MetalGeometry& g, int boundary_type) {
    float epsilon = boundary_epsilon(g, boundary_type);
    return (g.delta_x * g.delta_x) / (6.0f * epsilon);
}

inline bool reflect_pos(constant MetalGeometry& g, thread PathState& s) {
    bool hit_boundary = false;
    float x_max = static_cast<float>(g.nx) * g.xy_resolution;
    float y_max = static_cast<float>(g.ny) * g.xy_resolution;
    float z_max = static_cast<float>(g.nz_total) * g.z_resolution;

    if (s.z < 0.0f || s.z > z_max) {
        hit_boundary = true;
    }
    if (s.z < 0.0f) s.z = 0.0f;
    if (s.z > z_max) s.z = z_max;

    if (s.x < 0.0f) {
        s.x = -s.x;
    } else if (s.x > x_max) {
        s.x = 2.0f * x_max - s.x;
    }

    if (s.y < 0.0f) {
        s.y = -s.y;
    } else if (s.y > y_max) {
        s.y = 2.0f * y_max - s.y;
    }

    return hit_boundary;
}

inline void snap_virtual_layer(constant MetalGeometry& g, thread PathState& s) {
    int region = region_by_coord(g, s.z);
    if (region == REGION_VIRTUAL_TOP || region == REGION_VIRTUAL_BOTTOM) {
        int z_idx = static_cast<int>(floor(s.z / g.z_resolution));
        int y_idx = static_cast<int>(floor(s.y / g.xy_resolution));
        int x_idx = static_cast<int>(floor(s.x / g.xy_resolution));
        s.z = static_cast<float>(z_idx) * g.z_resolution + 0.5f * g.z_resolution;
        s.y = static_cast<float>(y_idx) * g.xy_resolution + 0.5f * g.xy_resolution;
        s.x = static_cast<float>(x_idx) * g.xy_resolution + 0.5f * g.xy_resolution;
    }
}

inline bool step_wos_radius(constant MetalGeometry& g, thread PathState& s, float r) {
    r = max(r, 0.0f);
    float u = 2.0f * rand01(s.rng) - 1.0f;
    float phi = TWO_PI * rand01(s.rng);
    float lateral = sqrt(max(0.0f, 1.0f - u * u));
    float vx = lateral * cos(phi);
    float vy = lateral * sin(phi);
    float vz = u;

    s.z += r * vz;
    s.y += r * vy;
    s.x += r * vx;

    bool hit_boundary = reflect_pos(g, s);
    snap_virtual_layer(g, s);
    return hit_boundary;
}

inline bool step_wos_auto(constant MetalGeometry& g, thread PathState& s) {
    int region = region_by_coord(g, s.z);
    float r;
    if (region == REGION_TOP) {
        float z_upper = static_cast<float>(g.z_top_end + 1) * g.z_resolution;
        float dist_to_heat_top = s.z - static_cast<float>(g.z_heat_end + 1) * g.z_resolution;
        float dist_to_top_boundary = z_upper - s.z;
        r = min(dist_to_heat_top, dist_to_top_boundary);
    } else {
        float z_lower = static_cast<float>(g.z_bottom_start) * g.z_resolution;
        float dist_to_heat_bottom = static_cast<float>(g.z_heat_start) * g.z_resolution - s.z;
        float dist_to_bottom_boundary = s.z - z_lower;
        r = min(dist_to_heat_bottom, dist_to_bottom_boundary);
    }
    return step_wos_radius(g, s, r);
}

inline void step_wog(constant MetalGeometry& g, thread PathState& s) {
    int iz = static_cast<int>(floor(s.z / g.z_resolution));
    int iy = static_cast<int>(floor(s.y / g.xy_resolution));
    int ix = static_cast<int>(floor(s.x / g.xy_resolution));

    float vals[6];
    get_conductance(g, iz, iy, ix, vals);
    float total = vals[0] + vals[1] + vals[2] + vals[3] + vals[4] + vals[5];
    if (total <= 0.0f) return;

    float u = rand01(s.rng) * total;
    float acc = vals[0];
    int choice = 0;
    if (u > acc) { acc += vals[1]; choice = 1; }
    if (u > acc) { acc += vals[2]; choice = 2; }
    if (u > acc) { acc += vals[3]; choice = 3; }
    if (u > acc) { acc += vals[4]; choice = 4; }
    if (u > acc) { choice = 5; }

    switch (choice) {
        case 0: s.x += g.xy_resolution; break;
        case 1: s.x -= g.xy_resolution; break;
        case 2: s.y += g.xy_resolution; break;
        case 3: s.y -= g.xy_resolution; break;
        case 4: s.z += g.z_resolution; break;
        case 5: s.z -= g.z_resolution; break;
        default: break;
    }

    float new_x = s.x;
    float new_y = s.y;
    if (new_x < 0.0f || new_x > static_cast<float>(g.nx) * g.xy_resolution ||
        new_y < 0.0f || new_y > static_cast<float>(g.ny) * g.xy_resolution) {
        reflect_pos(g, s);
    }
}

inline float get_heat_reward(constant MetalGeometry& g, device const float* power, thread PathState& s) {
    int iz = static_cast<int>(floor(s.z / g.z_resolution)) - g.z_heat_start;
    int iy = static_cast<int>(floor(s.y / g.xy_resolution));
    int ix = static_cast<int>(floor(s.x / g.xy_resolution));
    if (iz >= 0 && iz < g.nz_heat && iy >= 0 && iy <= g.ny && ix >= 0 && ix <= g.nx) {
        float gt = get_gt(g, iz + g.z_heat_start, iy, ix);
        if (gt > 0.0f) {
            return get_power_density(g, power, iz, iy, ix) / gt;
        }
    }
    return 0.0f;
}

inline void add_robin_side_counts(thread PathState& s, int bc_pos, int near_count, int hit_count) {
    if (bc_pos == BC_POS_TOP) {
        s.top_near_robin += near_count;
        s.top_hit_robin += hit_count;
    } else {
        s.bottom_near_robin += near_count;
        s.bottom_hit_robin += hit_count;
    }
    s.total_near_robin += near_count;
    s.total_hit_robin += hit_count;
}

inline void apply_robin_local_time(constant MetalGeometry& g, thread PathState& s, int bc_pos, float h, float dL) {
    float c = -h / g.k_medium;
    float phi = -c * g.T_am;
    float decay = c * dL;
    add_compensated(s.log_e_hat, s.log_e_hat_compensation, decay);
    s.e_hat = exp(s.log_e_hat);
    float t3 = s.e_hat * phi * dL;
    add_compensated(s.T3, s.C3, t3);
    s.robin_log_decay += decay;
    if (bc_pos == BC_POS_TOP) {
        s.top_local_time += dL;
        s.top_T3 += t3;
    } else {
        s.bottom_local_time += dL;
        s.bottom_T3 += t3;
    }
}

inline void escape_robin(constant MetalGeometry& g, thread PathState& s) {
    if (s.hit_robin <= 0) return;

    float h = s.robin_parameter;
    float avg_step_per_hit = static_cast<float>(s.near_robin) / static_cast<float>(s.hit_robin);
    for (int i = 0; i < s.hit_robin; ++i) {
        float dL = estimate_local_time_increment(g, BC_ROBIN) * avg_step_per_hit;
        apply_robin_local_time(g, s, s.robin_position, h, dL);
    }
    add_robin_side_counts(s, s.robin_position, s.near_robin, s.hit_robin);
}

kernel void simulate_paths_kernel(
    constant MetalGeometry& g [[buffer(0)]],
    device const float* power [[buffer(1)]],
    device const float* temp [[buffer(2)]],
	    device const float* points [[buffer(3)]],
	    device float* out [[buffer(4)]],
	    device int* steps [[buffer(5)]],
	    device float* diagnostics [[buffer(6)]],
	    device const int* target_indices [[buffer(7)]],
	    device PassRecord* pass_records [[buffer(8)]],
	    device int* pass_counts [[buffer(9)]],
	    device int* pass_overflows [[buffer(10)]],
	    uint tid [[thread_position_in_grid]]
	) {
    int M = g.point_count;
    int N = g.samples_per_point;
    int total_paths = M * N;
    if (static_cast<int>(tid) >= total_paths) return;

    int point_idx = static_cast<int>(tid) / N;
    uint point_base = static_cast<uint>(point_idx) * 3u;

    PathState s;
    s.z = points[point_base + 0];
    s.y = points[point_base + 1];
    s.x = points[point_base + 2];
    s.T0 = 0.0f;
    s.T1 = 0.0f;
    s.T2 = 0.0f;
    s.T3 = 0.0f;
    s.C0 = 0.0f;
    s.C1 = 0.0f;
    s.C2 = 0.0f;
    s.C3 = 0.0f;
    s.T0_unweighted = 0.0f;
    s.C0_unweighted = 0.0f;
    s.heat_e_hat_sum = 0.0f;
    s.C_heat_e_hat_sum = 0.0f;
    s.e_hat = 1.0f;
    s.log_e_hat = 0.0f;
    s.log_e_hat_compensation = 0.0f;
	    s.near_robin = 0;
	    s.hit_robin = 0;
	    s.total_near_robin = 0;
	    s.total_hit_robin = 0;
	    s.cutoff_count = 0;
	    s.step_count = 0;
	    s.in_robin = false;
	    s.robin_parameter = 0.0f;
	    s.robin_position = BC_POS_TOP;
	    s.top_near_robin = 0;
	    s.top_hit_robin = 0;
	    s.bottom_near_robin = 0;
	    s.bottom_hit_robin = 0;
	    s.top_local_time = 0.0f;
	    s.bottom_local_time = 0.0f;
	    s.top_T3 = 0.0f;
	    s.bottom_T3 = 0.0f;
	    s.robin_log_decay = 0.0f;
	    s.tail_e_hat = 0.0f;
	    s.tail_temperature = 0.0f;
	    s.heat_visit_count = 0;
	    s.heat_reward_nonzero_count = 0;
	    s.heat_pending_robin_count = 0;
	    s.virtual_top_visit_count = 0;
	    s.virtual_bottom_visit_count = 0;
	    s.heat_pending_robin_unweighted_reward = 0.0f;
	    s.rng = pcg_hash(g.seed ^ (tid * 747796405u + 2891336453u));
	    int last_record = 0;
	    int pass_count = 0;
	    int pass_overflow = 0;

    while (s.step_count < g.max_steps) {
        int region = region_by_coord(g, s.z);
        int bc_pos = BC_POS_TOP;
        int bc_type = BC_DIRICHLET;
        float bc_param = 0.0f;
        bool near = is_near_boundary(g, s.z, bc_pos, bc_type, bc_param);

        if (!near) {
            if (region == REGION_HEAT || region == REGION_VIRTUAL_TOP || region == REGION_VIRTUAL_BOTTOM) {
                if (region == REGION_HEAT) {
	                    float heat_reward = get_heat_reward(g, power, s);
	                    if (s.step_count - last_record > 1000 && fabs(1.0f - s.e_hat) > 0.1f) {
	                        int iz = static_cast<int>(floor(s.z / g.z_resolution));
	                        int iy = static_cast<int>(floor(s.y / g.xy_resolution));
	                        int ix = static_cast<int>(floor(s.x / g.xy_resolution));
	                        int target_index = -1;
	                        for (int target = 0; target < M; ++target) {
	                            int target_base = target * 3;
	                            if (iz == target_indices[target_base + 0] &&
	                                iy == target_indices[target_base + 1] &&
	                                ix == target_indices[target_base + 2]) {
	                                target_index = target;
	                            }
	                        }
	                        if (target_index >= 0) {
	                            int record_index = pass_count;
	                            if (record_index < MAX_PASS_RECORDS_PER_PATH) {
	                                uint out_index = tid * static_cast<uint>(MAX_PASS_RECORDS_PER_PATH)
	                                               + static_cast<uint>(record_index);
	                                pass_records[out_index].target_index = target_index;
	                                pass_records[out_index].t_sum = s.T0 + s.T1 + s.T2 + s.T3 + s.e_hat * heat_reward;
	                                pass_records[out_index].e_hat = s.e_hat;
	                                pass_records[out_index].step_count = s.step_count;
	                                pass_records[out_index].record_index = record_index;
	                            } else {
	                                pass_overflow = 1;
	                            }
	                            pass_count += 1;
	                            last_record = s.step_count;
	                        }
	                    }
	                    add_compensated(s.T0, s.C0, s.e_hat * heat_reward);
	                    add_compensated(s.T0_unweighted, s.C0_unweighted, heat_reward);
	                    add_compensated(s.heat_e_hat_sum, s.C_heat_e_hat_sum, s.e_hat);
	                    s.heat_visit_count += 1;
	                    if (heat_reward != 0.0f) {
	                        s.heat_reward_nonzero_count += 1;
	                    }
	                    if (s.in_robin) {
	                        s.heat_pending_robin_count += 1;
	                        s.heat_pending_robin_unweighted_reward += heat_reward;
	                    }
	                    if (s.e_hat < g.cutoff_weight) {
	                        int iz = static_cast<int>(floor(s.z / g.z_resolution)) - g.z_heat_start;
	                        int iy = static_cast<int>(floor(s.y / g.xy_resolution));
	                        int ix = static_cast<int>(floor(s.x / g.xy_resolution));
	                        float tail_temperature = get_tail_temperature_at(g, temp, iz, iy, ix);
	                        s.cutoff_count = 1;
	                        s.tail_e_hat = s.e_hat;
	                        s.tail_temperature = tail_temperature;
	                        if (g.use_tail_correction != 0 && g.tail_mode == TAIL_MODE_GT) {
	                            add_compensated(s.T1, s.C1, s.e_hat * tail_temperature);
	                        }
	                        break;
	                    }
                } else if (region == REGION_VIRTUAL_TOP) {
                    s.virtual_top_visit_count += 1;
                } else if (region == REGION_VIRTUAL_BOTTOM) {
                    s.virtual_bottom_visit_count += 1;
                }
                step_wog(g, s);
            } else {
                if (s.in_robin) {
                    escape_robin(g, s);
                    s.near_robin = 0;
                    s.hit_robin = 0;
                    s.in_robin = false;
                    s.robin_parameter = 0.0f;
                    s.robin_position = BC_POS_TOP;
                }
                step_wos_auto(g, s);
            }
        } else {
            if (bc_type == BC_DIRICHLET) {
                add_compensated(s.T1, s.C1, s.e_hat * bc_param);
                break;
            }

            bool is_top = (bc_pos == BC_POS_TOP);
            bool is_very_close = is_top
                ? (s.z >= static_cast<float>(g.nz_total) * g.z_resolution - g.delta_x)
                : (s.z <= g.delta_x);
            float step_length = is_very_close ? (2.0f * g.delta_x) : g.delta_x;

            if (bc_type == BC_NEUMANN) {
                float dL = estimate_local_time_increment(g, bc_type);
                add_compensated(s.T2, s.C2, s.e_hat * bc_param * dL);
                step_wos_radius(g, s, step_length);
            } else if (bc_type == BC_ROBIN) {
	                int near_increment = is_very_close ? 4 : 1;
	                if (g.robin_local_time_mode == ROBIN_MODE_CURRENT) {
	                    if (!s.in_robin) {
	                        s.in_robin = true;
	                        s.robin_parameter = bc_param;
	                        s.robin_position = bc_pos;
	                        s.near_robin = 0;
	                        s.hit_robin = 0;
	                    }
	                    s.near_robin += near_increment;
	                } else {
	                    add_robin_side_counts(s, bc_pos, near_increment, 0);
	                    if (g.robin_local_time_mode == ROBIN_MODE_EVENT) {
	                        apply_robin_local_time(g, s, bc_pos, bc_param,
	                            estimate_local_time_increment(g, BC_ROBIN) * static_cast<float>(near_increment));
	                    }
	                }

	                bool boundary_hit = step_wos_radius(g, s, step_length);
	                if (boundary_hit) {
	                    if (g.robin_local_time_mode == ROBIN_MODE_CURRENT) {
	                        s.hit_robin += 1;
	                    } else {
	                        add_robin_side_counts(s, bc_pos, 0, 1);
	                        if (g.robin_local_time_mode == ROBIN_MODE_HIT) {
	                            apply_robin_local_time(g, s, bc_pos, bc_param,
	                                estimate_local_time_increment(g, BC_ROBIN) * static_cast<float>(near_increment));
	                        }
	                    }
	                }
	            }
        }

        s.step_count++;
    }

    if (s.in_robin) {
        escape_robin(g, s);
    }

	    out[tid] = s.T0 + s.T1 + s.T2 + s.T3;
	    steps[tid] = s.step_count;
	    uint diag_base = tid * DIAG_STRIDE;
	    diagnostics[diag_base + 0] = s.T0;
	    diagnostics[diag_base + 1] = s.T1;
	    diagnostics[diag_base + 2] = s.T2;
	    diagnostics[diag_base + 3] = s.T3;
	    diagnostics[diag_base + 4] = static_cast<float>(s.cutoff_count);
	    diagnostics[diag_base + 5] = s.tail_e_hat;
	    diagnostics[diag_base + 6] = s.tail_temperature;
	    diagnostics[diag_base + 7] = static_cast<float>(s.total_hit_robin);
	    diagnostics[diag_base + 8] = static_cast<float>(s.total_near_robin);
	    diagnostics[diag_base + 9] = s.e_hat;
	    diagnostics[diag_base + 10] = static_cast<float>(s.top_hit_robin);
	    diagnostics[diag_base + 11] = static_cast<float>(s.top_near_robin);
	    diagnostics[diag_base + 12] = s.top_local_time;
	    diagnostics[diag_base + 13] = s.top_T3;
	    diagnostics[diag_base + 14] = static_cast<float>(s.bottom_hit_robin);
	    diagnostics[diag_base + 15] = static_cast<float>(s.bottom_near_robin);
	    diagnostics[diag_base + 16] = s.bottom_local_time;
	    diagnostics[diag_base + 17] = s.bottom_T3;
	    diagnostics[diag_base + 18] = exp(s.robin_log_decay);
	    diagnostics[diag_base + 19] = s.top_local_time + s.bottom_local_time;
	    diagnostics[diag_base + 20] = s.T0_unweighted;
	    diagnostics[diag_base + 21] = s.heat_e_hat_sum;
	    diagnostics[diag_base + 22] = static_cast<float>(s.heat_visit_count);
	    diagnostics[diag_base + 23] = static_cast<float>(s.heat_reward_nonzero_count);
	    diagnostics[diag_base + 24] = static_cast<float>(s.heat_pending_robin_count);
	    diagnostics[diag_base + 25] = s.heat_pending_robin_unweighted_reward;
	    diagnostics[diag_base + 26] = static_cast<float>(s.virtual_top_visit_count);
	    diagnostics[diag_base + 27] = static_cast<float>(s.virtual_bottom_visit_count);
	    pass_counts[tid] = min(pass_count, MAX_PASS_RECORDS_PER_PATH);
	    pass_overflows[tid] = pass_overflow;
		}
)MSL";

std::string ns_error_message(NSError* error) {
    if (error == nil) return "unknown Metal error";
    NSString* description = [error localizedDescription];
    return description != nil ? std::string([description UTF8String]) : "unknown Metal error";
}

int parse_tail_mode(const std::string& tail_mode) {
    if (tail_mode == "gt") return kTailModeGt;
    if (tail_mode == "none") return kTailModeNone;
    throw std::runtime_error("Unknown walker.tail_mode: " + tail_mode + " (expected \"gt\" or \"none\")");
}

int parse_robin_local_time_mode(const std::string& mode) {
    if (mode == "current") return kRobinModeCurrent;
    if (mode == "event") return kRobinModeEvent;
    if (mode == "hit") return kRobinModeHit;
    throw std::runtime_error("Unknown walker.robin_local_time_mode: " + mode
        + " (expected \"current\", \"event\", or \"hit\")");
}

double temperature_index_clamped(const GeometryConfig& geom, int iz, int iy, int ix) {
    iz = std::clamp(iz, 0, geom.nz_heat - 1);
    iy = std::clamp(iy, 0, geom.ny - 1);
    ix = std::clamp(ix, 0, geom.nx - 1);
    const auto& field = geom.reference_temperature_field.empty()
        ? geom.temperature_field
        : geom.reference_temperature_field;
    return field[iz][iy][ix];
}

double gt_floor_lookup(const GeometryConfig& geom, const Position& p) {
    int iz = static_cast<int>(std::floor(p[0] / geom.z_resolution)) - geom.z_heat.first;
    int iy = static_cast<int>(std::floor(p[1] / geom.xy_resolution));
    int ix = static_cast<int>(std::floor(p[2] / geom.xy_resolution));
    return temperature_index_clamped(geom, iz, iy, ix);
}

double gt_nearest_center_lookup(const GeometryConfig& geom, const Position& p) {
    int iz = static_cast<int>(std::llround(p[0] / geom.z_resolution - 0.5)) - geom.z_heat.first;
    int iy = static_cast<int>(std::llround(p[1] / geom.xy_resolution - 0.5));
    int ix = static_cast<int>(std::llround(p[2] / geom.xy_resolution - 0.5));
    return temperature_index_clamped(geom, iz, iy, ix);
}

double gt_bilinear_xy_lookup(const GeometryConfig& geom, const Position& p) {
    int iz = static_cast<int>(std::floor(p[0] / geom.z_resolution)) - geom.z_heat.first;
    double fy = p[1] / geom.xy_resolution;
    double fx = p[2] / geom.xy_resolution;
    int iy0 = static_cast<int>(std::floor(fy));
    int ix0 = static_cast<int>(std::floor(fx));
    double ty = fy - static_cast<double>(iy0);
    double tx = fx - static_cast<double>(ix0);
    int iy1 = iy0 + 1;
    int ix1 = ix0 + 1;

    double v00 = temperature_index_clamped(geom, iz, iy0, ix0);
    double v10 = temperature_index_clamped(geom, iz, iy0, ix1);
    double v01 = temperature_index_clamped(geom, iz, iy1, ix0);
    double v11 = temperature_index_clamped(geom, iz, iy1, ix1);
    double vx0 = v00 * (1.0 - tx) + v10 * tx;
    double vx1 = v01 * (1.0 - tx) + v11 * tx;
    return vx0 * (1.0 - ty) + vx1 * ty;
}

void write_constraints_to_json(
    const std::vector<std::vector<PassSample>>& all_pass_samples,
    int M,
    int N,
    const std::vector<std::vector<double>>& obs_data,
    const std::string& filename,
    long long pass_overflow_paths = 0
) {
    std::vector<int> i_k;
    std::vector<int> j_k;
    std::vector<double> alpha_k;
    std::vector<double> b_k;
    std::vector<int> sample_k;
    std::vector<int> step_k;
    std::vector<int> record_k;

    for (int i = 0; i < static_cast<int>(all_pass_samples.size()); ++i) {
        for (const auto& ps : all_pass_samples[i]) {
            i_k.push_back(i + 1);
            j_k.push_back(ps.target_index + 1);
            alpha_k.push_back(ps.e_hat);
            b_k.push_back(ps.t_sum);
            sample_k.push_back(ps.sample_index + 1);
            step_k.push_back(ps.step_count);
            record_k.push_back(ps.record_index + 1);
        }
    }
    int self_constraints = 0;
    for (size_t k = 0; k < i_k.size(); ++k) {
        if (i_k[k] == j_k[k]) self_constraints++;
    }

    json j;
    j["constraint_schema_version"] = 2;
    j["M"] = M;
    j["N"] = N;
    j["K"] = static_cast<int>(i_k.size());
    j["i_k"] = i_k;
    j["j_k"] = j_k;
    j["alpha_k"] = alpha_k;
    j["b_k"] = b_k;
    j["sample_k"] = sample_k;
    j["step_k"] = step_k;
    j["record_k"] = record_k;
    j["obs_data"] = obs_data;
    j["self_constraints"] = self_constraints;
    j["pass_overflow_paths"] = pass_overflow_paths;

    std::filesystem::path output_path(filename);
    if (output_path.has_parent_path()) {
        std::filesystem::create_directories(output_path.parent_path());
    }
    std::ofstream out(output_path);
    out << std::setw(2) << j << std::endl;
}

std::vector<float> flatten_power_density(const GeometryConfig& geom, double power_scale) {
    (void)power_scale;
    const int nxp = geom.nx + 1;
    const int nyp = geom.ny + 1;
    std::vector<float> flat(static_cast<size_t>(geom.nz_heat) * nyp * nxp, 0.0f);
    for (int iz = 0; iz < geom.nz_heat; ++iz) {
        for (int iy = 0; iy < nyp; ++iy) {
            for (int ix = 0; ix < nxp; ++ix) {
                size_t idx = static_cast<size_t>(iz) * nyp * nxp
                           + static_cast<size_t>(iy) * nxp
                           + static_cast<size_t>(ix);
                flat[idx] = static_cast<float>(geom.power_density[iz][iy][ix]);
            }
        }
    }
    return flat;
}

void write_metal_diagnostics_to_json(
    const GeometryConfig& geom,
    const std::vector<Position>& start_points,
    const std::vector<MultiPointStats>& stats,
    const std::vector<double>& diagnostic_sums,
    int N,
    unsigned int seed,
    double cutoff_weight,
    double power_scale,
    const std::string& tail_mode,
    const std::string& robin_local_time_mode,
    const std::string& filename
) {
    if (filename.empty()) return;

    json j;
    j["samples"] = N;
    j["seed"] = seed;
    j["cutoff_weight"] = cutoff_weight;
    j["power_scale"] = power_scale;
    j["tail_mode"] = tail_mode;
    j["robin_local_time_mode"] = robin_local_time_mode;
    j["diagnostic_stride"] = kDiagnosticStride;
    j["point_diagnostics"] = json::array();

    for (size_t i = 0; i < start_points.size(); ++i) {
        const size_t base = i * kDiagnosticStride;
        double t0 = diagnostic_sums[base + 0] / N;
        double t1 = diagnostic_sums[base + 1] / N;
        double t2 = diagnostic_sums[base + 2] / N;
        double t3 = diagnostic_sums[base + 3] / N;
        double cutoff_total = diagnostic_sums[base + 4];
        double heat_unweighted = diagnostic_sums[base + 20] / N;
        double heat_e_hat_sum = diagnostic_sums[base + 21];
        double heat_visit_total = diagnostic_sums[base + 22];
        double heat_reward_nonzero_total = diagnostic_sums[base + 23];
        double pending_robin_heat_total = diagnostic_sums[base + 24];
        double component_sum = t0 + t1 + t2 + t3;
        const auto& p = start_points[i];

        json point;
        point["point"] = i;
        point["x"] = p[2];
        point["y"] = p[1];
        point["z"] = p[0];
        point["normal_mean"] = stats[i].normal_mean;
        point["component_sum"] = component_sum;
        point["component_difference"] = stats[i].normal_mean - component_sum;
        point["components"] = {
            {"T0_heat", t0},
            {"T1_tail_or_dirichlet", t1},
            {"T2_neumann", t2},
            {"T3_robin", t3}
        };
        point["heat"] = {
            {"T0_weighted_mean", t0},
            {"T0_unweighted_mean", heat_unweighted},
            {"avg_e_hat_on_heat", heat_unweighted > 0.0 ? t0 / heat_unweighted : 0.0},
            {"heat_visit_count_mean", heat_visit_total / N},
            {"heat_reward_nonzero_count_mean", heat_reward_nonzero_total / N},
            {"heat_visit_e_hat_mean", heat_visit_total > 0.0 ? heat_e_hat_sum / heat_visit_total : 0.0},
            {"pending_robin_heat_count_mean", pending_robin_heat_total / N},
            {"pending_robin_heat_fraction", heat_visit_total > 0.0
                ? pending_robin_heat_total / heat_visit_total : 0.0},
            {"pending_robin_T0_unweighted_mean", diagnostic_sums[base + 25] / N},
            {"virtual_top_visit_count_mean", diagnostic_sums[base + 26] / N},
            {"virtual_bottom_visit_count_mean", diagnostic_sums[base + 27] / N}
        };
        point["cutoff"] = {
            {"count_total", cutoff_total},
            {"fraction", cutoff_total / N},
            {"tail_e_hat_mean_when_cutoff", cutoff_total > 0.0 ? diagnostic_sums[base + 5] / cutoff_total : 0.0},
            {"tail_temperature_mean_when_cutoff", cutoff_total > 0.0 ? diagnostic_sums[base + 6] / cutoff_total : 0.0}
        };
        point["robin"] = {
            {"hit_count_mean", diagnostic_sums[base + 7] / N},
            {"near_count_mean", diagnostic_sums[base + 8] / N},
            {"top_hit_count_mean", diagnostic_sums[base + 10] / N},
            {"top_near_count_mean", diagnostic_sums[base + 11] / N},
            {"top_effective_local_time_mean", diagnostic_sums[base + 12] / N},
            {"top_T3_robin_mean", diagnostic_sums[base + 13] / N},
            {"bottom_hit_count_mean", diagnostic_sums[base + 14] / N},
            {"bottom_near_count_mean", diagnostic_sums[base + 15] / N},
            {"bottom_effective_local_time_mean", diagnostic_sums[base + 16] / N},
            {"bottom_T3_robin_mean", diagnostic_sums[base + 17] / N},
            {"exp_minus_hL_over_k_mean", diagnostic_sums[base + 18] / N},
            {"effective_local_time_mean", diagnostic_sums[base + 19] / N}
        };
        point["final_e_hat_mean"] = diagnostic_sums[base + 9] / N;
        point["gt_lookup"] = {
            {"floor", gt_floor_lookup(geom, p)},
            {"nearest_center", gt_nearest_center_lookup(geom, p)},
            {"bilinear_xy", gt_bilinear_xy_lookup(geom, p)}
        };
        j["point_diagnostics"].push_back(point);
    }

    std::filesystem::path output_path(filename);
    if (output_path.has_parent_path()) {
        std::filesystem::create_directories(output_path.parent_path());
    }
    std::ofstream out(output_path);
    out << std::setw(2) << j << std::endl;
}

std::vector<float> flatten_prior_temperature_field(const GeometryConfig& geom) {
    std::vector<float> flat(static_cast<size_t>(geom.nz_heat) * geom.ny * geom.nx, 0.0f);
    for (int iz = 0; iz < geom.nz_heat; ++iz) {
        for (int iy = 0; iy < geom.ny; ++iy) {
            for (int ix = 0; ix < geom.nx; ++ix) {
                size_t idx = static_cast<size_t>(iz) * geom.ny * geom.nx
                           + static_cast<size_t>(iy) * geom.nx
                           + static_cast<size_t>(ix);
                flat[idx] = static_cast<float>(geom.temperature_field[iz][iy][ix]);
            }
        }
    }
    return flat;
}
} // namespace

struct RandomWalkerMetal::Impl {
    GeometryConfig& geom;
    double max_steps;
    double cutoff_weight;
    double delta_x;
    bool use_tail_correction;
    std::optional<unsigned int> configured_seed;
    double power_scale;
    std::string tail_mode;
    int tail_mode_code;
    std::string robin_local_time_mode;
    int robin_local_time_mode_code;

    id<MTLDevice> device;
    id<MTLCommandQueue> command_queue;
    id<MTLComputePipelineState> pipeline;
    id<MTLBuffer> power_buffer;
    id<MTLBuffer> temp_buffer;

    Impl(GeometryConfig& geometry_config, double max_steps_, double cutoff_weight_,
         double delta_x_, bool use_tail_correction_, std::optional<unsigned int> seed_,
         double power_scale_, const std::string& tail_mode_, const std::string& robin_local_time_mode_)
    : geom(geometry_config),
      max_steps(max_steps_),
      cutoff_weight(cutoff_weight_),
      delta_x(delta_x_),
      use_tail_correction(use_tail_correction_),
      configured_seed(seed_),
      power_scale(power_scale_),
      tail_mode(tail_mode_),
      tail_mode_code(parse_tail_mode(tail_mode_)),
      robin_local_time_mode(robin_local_time_mode_),
      robin_local_time_mode_code(parse_robin_local_time_mode(robin_local_time_mode_)),
      device(nil),
      command_queue(nil),
      pipeline(nil),
      power_buffer(nil),
      temp_buffer(nil) {
        @autoreleasepool {
            device = MTLCreateSystemDefaultDevice();
            if (device == nil) {
                throw std::runtime_error("Metal is not available on this machine.");
            }

            command_queue = [device newCommandQueue];
            if (command_queue == nil) {
                throw std::runtime_error("Failed to create Metal command queue.");
            }

            NSError* error = nil;
            NSString* source = [NSString stringWithUTF8String:kMetalSource];
            id<MTLLibrary> library = [device newLibraryWithSource:source options:nil error:&error];
            if (library == nil) {
                throw std::runtime_error("Failed to compile Metal library: " + ns_error_message(error));
            }

            id<MTLFunction> function = [library newFunctionWithName:@"simulate_paths_kernel"];
            if (function == nil) {
                throw std::runtime_error("Failed to load Metal kernel simulate_paths_kernel.");
            }

            pipeline = [device newComputePipelineStateWithFunction:function error:&error];
            if (pipeline == nil) {
                throw std::runtime_error("Failed to create Metal compute pipeline: " + ns_error_message(error));
            }

            upload_geometry_data();
        }
    }

    void upload_geometry_data() {
        std::vector<float> power = flatten_power_density(geom, power_scale);
        std::vector<float> temp = flatten_prior_temperature_field(geom);

        power_buffer = [device newBufferWithBytes:power.data()
                                           length:power.size() * sizeof(float)
                                          options:MTLResourceStorageModeShared];
        if (power_buffer == nil) {
            throw std::runtime_error("Failed to create Metal power-density buffer.");
        }

        temp_buffer = [device newBufferWithBytes:temp.data()
                                          length:temp.size() * sizeof(float)
                                         options:MTLResourceStorageModeShared];
        if (temp_buffer == nil) {
            throw std::runtime_error("Failed to create Metal temperature buffer.");
        }
    }

    MetalGeometryHost make_geometry(unsigned int seed) const {
        MetalGeometryHost g{};
        g.nx = geom.nx;
        g.ny = geom.ny;
        g.nz_heat = geom.nz_heat;
        g.nz_total = geom.nz_total;

        g.z_bottom_start = geom.z_bottom.first;
        g.z_bottom_end = geom.z_bottom.second;
        g.z_virtual1_start = geom.z_virtual1.first;
        g.z_virtual1_end = geom.z_virtual1.second;
        g.z_heat_start = geom.z_heat.first;
        g.z_heat_end = geom.z_heat.second;
        g.z_virtual2_start = geom.z_virtual2.first;
        g.z_virtual2_end = geom.z_virtual2.second;
        g.z_top_start = geom.z_top.first;
        g.z_top_end = geom.z_top.second;

        g.x_size = static_cast<float>(geom.x_size);
        g.y_size = static_cast<float>(geom.y_size);
        g.xy_resolution = static_cast<float>(geom.xy_resolution);
        g.z_resolution = static_cast<float>(geom.z_resolution);
        g.T_am = static_cast<float>(geom.T_am);
        g.k_source = static_cast<float>(geom.k_source);
        g.k_medium = static_cast<float>(geom.k_medium);

        g.top_boundary_type = static_cast<int>(geom.top_boundary_type);
        g.bottom_boundary_type = static_cast<int>(geom.bottom_boundary_type);
        g.lateral_boundary_type = static_cast<int>(geom.lateral_boundary_type);
        g.top_boundary_param = static_cast<float>(geom.top_boundary_param);
        g.bottom_boundary_param = static_cast<float>(geom.bottom_boundary_param);
        g.lateral_boundary_param = static_cast<float>(geom.lateral_boundary_param);
        g.eps_dirichlet = static_cast<float>(geom.boundary_epsilon[0]);
        g.eps_neumann = static_cast<float>(geom.boundary_epsilon[1]);
        g.eps_robin = static_cast<float>(geom.boundary_epsilon[2]);

        g.max_steps = static_cast<int>(std::min<double>(max_steps, std::numeric_limits<int>::max()));
        g.cutoff_weight = static_cast<float>(cutoff_weight);
        g.delta_x = static_cast<float>(delta_x);
        g.power_nx = geom.nx + 1;
        g.power_ny = geom.ny + 1;
        g.use_tail_correction = use_tail_correction ? 1 : 0;
        g.tail_mode = tail_mode_code;
        g.robin_local_time_mode = robin_local_time_mode_code;
        g.point_count = 0;
        g.samples_per_point = 0;
        g.seed = seed;
        return g;
    }

	    std::vector<MultiPointStats> simulate_temperature_multi(
	        const std::vector<Position>& start_points,
	        int N,
	        int requested_threads_per_threadgroup,
	        int print_interval,
	        const std::string& constraints_json,
	        const std::string& diagnostics_json
	    ) {
	        const int M = static_cast<int>(start_points.size());
	        if (M == 0 || N <= 0) return {};

	        @autoreleasepool {
	            std::vector<float> points(static_cast<size_t>(M) * 3, 0.0f);
	            std::vector<int> target_indices(static_cast<size_t>(M) * 3, 0);
	            for (int i = 0; i < M; ++i) {
	                points[static_cast<size_t>(i) * 3 + 0] = static_cast<float>(start_points[i][0]);
	                points[static_cast<size_t>(i) * 3 + 1] = static_cast<float>(start_points[i][1]);
	                points[static_cast<size_t>(i) * 3 + 2] = static_cast<float>(start_points[i][2]);
	                target_indices[static_cast<size_t>(i) * 3 + 0] = static_cast<int>(std::floor(start_points[i][0] / geom.z_resolution));
	                target_indices[static_cast<size_t>(i) * 3 + 1] = static_cast<int>(std::floor(start_points[i][1] / geom.xy_resolution));
	                target_indices[static_cast<size_t>(i) * 3 + 2] = static_cast<int>(std::floor(start_points[i][2] / geom.xy_resolution));
	            }

	            unsigned int seed = configured_seed.value_or(static_cast<unsigned int>(
	                std::chrono::high_resolution_clock::now().time_since_epoch().count()));
	            id<MTLBuffer> points_buffer = [device newBufferWithBytes:points.data()
	                                                               length:points.size() * sizeof(float)
	                                                              options:MTLResourceStorageModeShared];
	            if (points_buffer == nil) {
	                throw std::runtime_error("Failed to allocate Metal points buffer.");
	            }
	            id<MTLBuffer> target_indices_buffer = [device newBufferWithBytes:target_indices.data()
	                                                                       length:target_indices.size() * sizeof(int)
	                                                                      options:MTLResourceStorageModeShared];
	            if (target_indices_buffer == nil) {
	                throw std::runtime_error("Failed to allocate Metal target-index buffer.");
	            }

	            NSUInteger max_threads = [pipeline maxTotalThreadsPerThreadgroup];
	            NSUInteger threads_per_threadgroup = 256;
	            if (requested_threads_per_threadgroup > 0) {
	                threads_per_threadgroup = static_cast<NSUInteger>(requested_threads_per_threadgroup);
	            }
	            threads_per_threadgroup = std::max<NSUInteger>(1, std::min<NSUInteger>(threads_per_threadgroup, max_threads));

	            MTLSize group_size = MTLSizeMake(threads_per_threadgroup, 1, 1);
	            constexpr int max_samples_per_dispatch = 100;
	            const int dispatch_count = (N + max_samples_per_dispatch - 1) / max_samples_per_dispatch;
		            std::vector<std::vector<double>> obs_data(N, std::vector<double>(M, 0.0));
		            std::vector<std::vector<PassSample>> all_pass_samples(M);
		            std::vector<double> sums(M, 0.0);
		            std::vector<long long> step_sums(M, 0);
		            std::vector<double> diagnostic_sums(static_cast<size_t>(M) * kDiagnosticStride, 0.0);
		            long long pass_overflow_paths = 0;
	            auto sim_start = std::chrono::high_resolution_clock::now();
	            for (int sample_offset = 0; sample_offset < N; sample_offset += max_samples_per_dispatch) {
	                const int batch_samples = std::min(max_samples_per_dispatch, N - sample_offset);
	                const int batch_total = M * batch_samples;
	                const unsigned int batch_seed = seed ^ (static_cast<unsigned int>(sample_offset) * 747796405u + 2891336453u);
	                MetalGeometryHost g = make_geometry(batch_seed);
	                g.point_count = M;
	                g.samples_per_point = batch_samples;

	                id<MTLBuffer> geometry_buffer = [device newBufferWithBytes:&g
	                                                                     length:sizeof(MetalGeometryHost)
	                                                                    options:MTLResourceStorageModeShared];
		                id<MTLBuffer> out_buffer = [device newBufferWithLength:static_cast<NSUInteger>(batch_total) * sizeof(float)
	                                                               options:MTLResourceStorageModeShared];
		                id<MTLBuffer> steps_buffer = [device newBufferWithLength:static_cast<NSUInteger>(batch_total) * sizeof(int)
		                                                                 options:MTLResourceStorageModeShared];
		                id<MTLBuffer> diagnostics_buffer = [device newBufferWithLength:static_cast<NSUInteger>(batch_total) * kDiagnosticStride * sizeof(float)
		                                                                       options:MTLResourceStorageModeShared];
		                id<MTLBuffer> pass_records_buffer = [device newBufferWithLength:static_cast<NSUInteger>(batch_total) * kMaxPassesPerPath * sizeof(MetalPassRecordHost)
		                                                                         options:MTLResourceStorageModeShared];
		                id<MTLBuffer> pass_counts_buffer = [device newBufferWithLength:static_cast<NSUInteger>(batch_total) * sizeof(int)
		                                                                        options:MTLResourceStorageModeShared];
		                id<MTLBuffer> pass_overflows_buffer = [device newBufferWithLength:static_cast<NSUInteger>(batch_total) * sizeof(int)
		                                                                           options:MTLResourceStorageModeShared];

		                if (geometry_buffer == nil || out_buffer == nil || steps_buffer == nil ||
		                    diagnostics_buffer == nil || pass_records_buffer == nil ||
		                    pass_counts_buffer == nil || pass_overflows_buffer == nil) {
		                    throw std::runtime_error("Failed to allocate one or more Metal simulation buffers.");
		                }

	                id<MTLCommandBuffer> command_buffer = [command_queue commandBuffer];
	                id<MTLComputeCommandEncoder> encoder = [command_buffer computeCommandEncoder];
	                [encoder setComputePipelineState:pipeline];
	                [encoder setBuffer:geometry_buffer offset:0 atIndex:0];
	                [encoder setBuffer:power_buffer offset:0 atIndex:1];
	                [encoder setBuffer:temp_buffer offset:0 atIndex:2];
		                [encoder setBuffer:points_buffer offset:0 atIndex:3];
		                [encoder setBuffer:out_buffer offset:0 atIndex:4];
		                [encoder setBuffer:steps_buffer offset:0 atIndex:5];
		                [encoder setBuffer:diagnostics_buffer offset:0 atIndex:6];
		                [encoder setBuffer:target_indices_buffer offset:0 atIndex:7];
		                [encoder setBuffer:pass_records_buffer offset:0 atIndex:8];
		                [encoder setBuffer:pass_counts_buffer offset:0 atIndex:9];
		                [encoder setBuffer:pass_overflows_buffer offset:0 atIndex:10];

	                MTLSize grid_size = MTLSizeMake(static_cast<NSUInteger>(batch_total), 1, 1);
	                [encoder dispatchThreads:grid_size threadsPerThreadgroup:group_size];
	                [encoder endEncoding];
	                [command_buffer commit];
	                [command_buffer waitUntilCompleted];

	                if ([command_buffer status] == MTLCommandBufferStatusError) {
	                    NSError* error = [command_buffer error];
	                    throw std::runtime_error("Metal simulation failed: " + ns_error_message(error));
	                }

		                const float* out = reinterpret_cast<const float*>([out_buffer contents]);
		                const int* steps = reinterpret_cast<const int*>([steps_buffer contents]);
		                const float* diagnostics = reinterpret_cast<const float*>([diagnostics_buffer contents]);
		                const MetalPassRecordHost* pass_records =
		                    reinterpret_cast<const MetalPassRecordHost*>([pass_records_buffer contents]);
		                const int* pass_counts = reinterpret_cast<const int*>([pass_counts_buffer contents]);
		                const int* pass_overflows = reinterpret_cast<const int*>([pass_overflows_buffer contents]);
		                for (int i = 0; i < M; ++i) {
		                    for (int n = 0; n < batch_samples; ++n) {
		                        const int sample_index = sample_offset + n;
		                        const int batch_index = i * batch_samples + n;
		                        double value = static_cast<double>(out[batch_index]);
		                        obs_data[sample_index][i] = value;
		                        sums[i] += value;
		                        step_sums[i] += steps[batch_index];
		                        const size_t diag_base = static_cast<size_t>(i) * kDiagnosticStride;
		                        const size_t batch_diag_base = static_cast<size_t>(batch_index) * kDiagnosticStride;
		                        for (int k = 0; k < kDiagnosticStride; ++k) {
		                            diagnostic_sums[diag_base + k] += static_cast<double>(diagnostics[batch_diag_base + k]);
		                        }
		                        if (pass_overflows[batch_index] != 0) {
		                            pass_overflow_paths += 1;
		                        }
		                        int pass_count = std::min(pass_counts[batch_index], kMaxPassesPerPath);
		                        const size_t pass_base = static_cast<size_t>(batch_index) * kMaxPassesPerPath;
		                        for (int p = 0; p < pass_count; ++p) {
		                            const MetalPassRecordHost& record = pass_records[pass_base + p];
		                            all_pass_samples[i].push_back({
		                                record.target_index,
		                                static_cast<double>(record.t_sum),
		                                static_cast<double>(record.e_hat),
		                                sample_index,
		                                record.step_count,
		                                record.record_index
		                            });
		                        }
		                    }
		                }
	            }
	            auto sim_end = std::chrono::high_resolution_clock::now();

	            if (pass_overflow_paths > 0) {
	                std::cerr << "Warning: Metal pass-through constraints exceeded max_passes_per_path="
	                          << kMaxPassesPerPath << " on " << pass_overflow_paths
	                          << " path(s); extra pass records were dropped." << std::endl;
	            }

	            write_constraints_to_json(all_pass_samples, M, N, obs_data, constraints_json, pass_overflow_paths);

		            std::vector<MultiPointStats> stats(M);
			            for (int i = 0; i < M; ++i) {
			                double normal_mean = sums[i] / static_cast<double>(N);
			                double sample_variance = 0.0;
			                if (N > 1) {
			                    double squared_diff_sum = 0.0;
			                    for (int n = 0; n < N; ++n) {
			                        const double diff = obs_data[n][i] - normal_mean;
			                        squared_diff_sum += diff * diff;
			                    }
			                    sample_variance = squared_diff_sum / static_cast<double>(N - 1);
			                }
			                double mean_variance = sample_variance / static_cast<double>(N);
			                double std_error = std::sqrt(mean_variance);
			                stats[i] = {N, normal_mean, sample_variance, mean_variance, std_error, static_cast<double>(step_sums[i]) / static_cast<double>(N)};
			            }
		            write_metal_diagnostics_to_json(
		                geom,
		                start_points,
		                stats,
		                diagnostic_sums,
		                N,
		                seed,
		                cutoff_weight,
		                power_scale,
		                tail_mode,
		                robin_local_time_mode,
		                diagnostics_json
		            );

	            if (print_interval > 0) {
	                std::cout << "Metal simulation complete in "
	                          << std::chrono::duration<double>(sim_end - sim_start).count()
	                          << " seconds using " << threads_per_threadgroup
	                          << " threads/threadgroup, seed=" << seed
	                          << ", dispatches=" << dispatch_count << "." << std::endl;
	            }
            return stats;
        }
    }
};

RandomWalkerMetal::RandomWalkerMetal(GeometryConfig& geometry_config, double max_steps,
                                     double cutoff_weight, double delta_x,
                                     bool use_tail_correction,
                                     std::optional<unsigned int> seed,
                                     double power_scale,
                                     std::string tail_mode,
                                     std::string robin_local_time_mode)
: impl(std::make_unique<Impl>(geometry_config, max_steps, cutoff_weight, delta_x,
                              use_tail_correction, seed, power_scale, tail_mode,
                              robin_local_time_mode)) {}

RandomWalkerMetal::~RandomWalkerMetal() = default;

double RandomWalkerMetal::simulate_temperature(const Position& x0_meter, int N,
                                               int threads_per_threadgroup,
                                               int print_interval) {
    std::vector<Position> points = {x0_meter};
    auto stats = impl->simulate_temperature_multi(points, N, threads_per_threadgroup, print_interval,
                                                  "outputs/data_metal_single.json", "");
    return stats.empty() ? 0.0 : stats[0].normal_mean;
}

std::vector<MultiPointStats> RandomWalkerMetal::simulate_temperature_multi(
    const std::vector<Position>& start_points,
    int N,
    int threads_per_threadgroup,
    int print_interval,
    const std::string& constraints_json,
    const std::string& diagnostics_json
) {
    return impl->simulate_temperature_multi(start_points, N, threads_per_threadgroup,
                                            print_interval, constraints_json, diagnostics_json);
}
