import numpy as np

class GeometryConfig:
    def __init__(self,
                 x_size=2e-2, y_size=2e-2,
                 bottom_thickness=5e-4,
                 heat_source_thickness=1e-4,
                 top_thickness=5e-4,
                 xy_resolution=1e-4,
                 z_resolution=2e-5,  # 默认 0.02 mm
                 z_boundary_types=('Robin', 'Dirichlet'),
                 z_boundary_params=(8700, 70),
                 lateral_boundary_type='Neumann',
                 lateral_boundary_params=(0),
                 boundary_epsilon={'Dirichlet': 1e-8, 'Neumann': 1.36 * 5e-7, 'Robin': 1.36 * 5e-7}
                 ):

        # === 几何尺寸与网格配置 ===
        self.x_size = x_size
        self.y_size = y_size
        self.bottom_thickness = bottom_thickness - z_resolution
        self.heat_source_thickness = heat_source_thickness
        self.top_thickness = top_thickness - z_resolution
        self.virtual_layer_thickness = z_resolution
        self.xy_resolution = xy_resolution
        self.z_resolution = z_resolution

        # === 空间网格划分 ===
        self.nx = int(x_size / xy_resolution)
        self.ny = int(y_size / xy_resolution)
        self.nz_bottom = int(self.bottom_thickness / z_resolution)
        self.nz_heat = int(heat_source_thickness / z_resolution)
        self.nz_top = int(self.top_thickness / z_resolution)
        self.nz_virtual = int(self.virtual_layer_thickness / z_resolution)
        self.nz_total = self.nz_bottom + 2 * self.nz_virtual + self.nz_heat + self.nz_top

        # === z方向区域索引 ===
        self.z_bottom = (0, self.nz_bottom - 1)
        self.z_virtual1 = (self.z_bottom[1] + 1, self.z_bottom[1] + self.nz_virtual)
        self.z_heat = (self.z_virtual1[1] + 1, self.z_virtual1[1] + self.nz_heat)
        self.z_virtual2 = (self.z_heat[1] + 1, self.z_heat[1] + self.nz_virtual)
        self.z_top = (self.z_virtual2[1] + 1, self.nz_total - 1)

        # === 边界条件设置 ===
        self.z_boundary_types = {
            'top': z_boundary_types[0],
            'bottom': z_boundary_types[1]
        }
        self.z_boundary_params = {
            'top': z_boundary_params[0],
            'bottom': z_boundary_params[1]
        }
        self.lateral_boundary_type = lateral_boundary_type
        self.lateral_boundary_params = lateral_boundary_params
        self.boundary_epsilon = boundary_epsilon

        # === 初始化热源 ===
        self.power_density = np.zeros((self.nz_heat, self.ny, self.nx))  # [z, y, x]

        self._initialize_heat_sources()

    def _initialize_heat_sources(self):
        patch_size = int(0.005 / self.xy_resolution)  # 每个方向5mm，对应的格点数
        power_value = 1e6  # W/m³

        x_starts = [int(0.25 * self.nx - patch_size/2.0), int(0.75 * self.nx - patch_size/2.0)]
        y_starts = [int(0.25 * self.ny - patch_size/2.0), int(0.75 * self.ny - patch_size/2.0)]

        for y0 in y_starts:
            for x0 in x_starts:
                for z in range(self.nz_heat):
                    self.power_density[z, y0:y0 + patch_size, x0:x0 + patch_size] = power_value

    def get_region_by_z(self, z_index):
        if self.z_bottom[0] <= z_index <= self.z_bottom[1]:
            return 'bottom'
        elif self.z_virtual1[0] <= z_index <= self.z_virtual1[1]:
            return 'virtual_bottom'
        elif self.z_heat[0] <= z_index <= self.z_heat[1]:
            return 'heat_source'
        elif self.z_virtual2[0] <= z_index <= self.z_virtual2[1]:
            return 'virtual_top'
        elif self.z_top[0] <= z_index <= self.z_top[1]:
            return 'top'
        else:
            return 'out_of_domain'

    def get_region_by_coord(self, z_coord):
        z_index = int(z_coord / self.z_resolution)
        return self.get_region_by_z(z_index)

    def is_near_boundary(self, pos):
        x, y, z = pos

        if z >= (self.nz_total - 1) * self.z_resolution - self.boundary_epsilon[self.z_boundary_types['top']]:
            return 'top', self.z_boundary_types['top'], self.z_boundary_params['top']

        if z <= self.boundary_epsilon[self.z_boundary_types['bottom']]:
            return 'bottom', self.z_boundary_types['bottom'], self.z_boundary_params['bottom']

        return None, None, None
    
    def get_conductance(self, pos_meter):
        """
        输入物理坐标 (z, y, x) 单位为米
        返回当前位置与6个方向相邻点之间的电导率 (W/K)，格式为 dict
        """
        z, y, x = pos_meter

        # 将物理坐标转为索引
        ix = int(x / self.xy_resolution)
        iy = int(y / self.xy_resolution)
        iz = int(z / self.z_resolution)

        # 辅助函数：判断某个索引点的热导率
        def get_k(iz_index):
            region = self.get_region_by_z(iz_index)
            return 125 if region == 'heat_source' else 395  # W/(K·m)

        k_center = get_k(iz)

        dx = self.xy_resolution
        dy = self.xy_resolution
        dz = self.z_resolution

        conductance = {}

        for direction, shift in {
            '+x': (0, 0, +1),
            '-x': (0, 0, -1),
            '+y': (0, +1, 0),
            '-y': (0, -1, 0),
            '+z': (+1, 0, 0),
            '-z': (-1, 0, 0),
        }.items():
            iz_n = iz + shift[0]
            iy_n = iy + shift[1]
            ix_n = ix + shift[2]

            # 判断越界
            out_of_bounds = (
                ix_n < 0 or ix_n >= self.nx or
                iy_n < 0 or iy_n >= self.ny or
                iz_n < 0 or iz_n >= self.nz_total
            )

            # 判断方向维度，设定面积和长度
            if direction in ['+x', '-x']:
                A = dy * dz
                d = dx
            elif direction in ['+y', '-y']:
                A = dx * dz
                d = dy
            else:  # +z, -z
                A = dx * dy
                d = dz

            if out_of_bounds:
                # 使用镜像边界近似：使用自身热导率计算对称导通
                if direction in ['+x', '-x', '+y', '-y']:
                    r = (1 / k_center) * (d / A)
                    g = 1 / r
                else:
                    g = 0.0  # z方向边界不允许越界
            else:
                k_neighbor = get_k(iz_n)
                r = 0.5 * (1 / k_center + 1 / k_neighbor) * (d / A)
                g = 1 / r

            conductance[direction] = g

        return conductance


if __name__=="__main__":
    geom = GeometryConfig()
