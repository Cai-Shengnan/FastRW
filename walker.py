import numpy as np
from multiprocessing import Pool, cpu_count
from tqdm import tqdm


class RandomWalker:
    def __init__(self, geometry_config, max_steps=100000, eps=5e-4, delta_x=5e-7):
        """
        geometry_config: GeometryConfig 实例
        max_steps: 每条路径的最大跳跃次数
        eps: Feynman-Kac 函数 e^c(t) 的终止阈值
        delta_x: 距离边界附近的 WOS 跳跃半径 Δx，来自论文定义，默认为 5e-7
        """
        self.geom = geometry_config
        self.max_steps = max_steps
        self.eps = eps
        self.delta_x = delta_x  # WOS 跳跃半径 Δx

        self.dx = geometry_config.xy_resolution
        self.dy = geometry_config.xy_resolution
        self.dz = geometry_config.z_resolution

    def simulate_temperature(self, x0_meter, N=1000, num_workers=None):
        args = [x0_meter] * N
        num_workers = num_workers or cpu_count()
        with Pool(num_workers) as pool:
            results = list(tqdm(pool.imap(self._simulate_single_path_wrapper, args), total=N))
        temps = [r[0] for r in results]
        trajs = [r[1] for r in results]
        return np.mean(temps), trajs

    def _simulate_single_path_wrapper(self, x0_meter):
        return self.simulate_single_path(x0_meter)

    def simulate_single_path(self, x0_meter):
        pos = np.array(x0_meter)
        T_i = 0.0
        e_hat = 1.0
        step_count = 0

        while step_count < self.max_steps and e_hat > self.eps:
            region = self.geom.get_region_by_coord(pos[0])
            bc_pos, bc_type, bc_param  = self.geom.is_near_boundary(pos)
            
            if bc_pos is None:
                if region in ['heat_source', 'virtual_top', 'virtual_bottom']:
                    reward = self._get_heat_reward(pos) if region == 'heat_source' else 0.0
                    T_i += e_hat * reward
                    pos = self._step_wog(pos)
                else:
                    pos = self._step_wos(pos)
            else:  
                if bc_type == 'Dirichlet':
                    phi = self._get_dirichlet_value(pos)
                    T_i += e_hat * phi
                    break
                else:
                    if bc_pos == "top":
                        is_very_close = (pos[0] >= ((self.geom.nz_total - 1) * self.geom.z_resolution - self.delta_x)) 
                    elif bc_pos == 'bottom':
                        is_very_close = (pos[0] <= self.delta_x) 
                    else:
                        raise ValueError 
                    if is_very_close:
                        step_lenth = 2 * self.delta_x
                    else:
                        step_lenth = self.delta_x
                        
                        
                    if bc_type == 'Neumann':
                        dL = self._estimate_local_time_increment(bc_type)
                        phi = bc_param
                        T_i += e_hat * phi * dL
                        pos = self._step_wos(pos, step_lenth)

                    elif bc_type == 'Robin':
                        dL = self._estimate_local_time_increment(bc_type)
                        phi = bc_param
                        k = 395
                        c =  -phi / k
                        e_hat *= np.exp(c * dL)
                        T_i += e_hat * phi * dL
                        pos = self._step_wos(pos, step_lenth)
            
            step_count += 1

        return T_i

    def _get_heat_reward(self, pos):
        z, y, x = pos
        iz = int(z / self.dz)
        iy = int(y / self.dy)
        ix = int(x / self.dx)
        if 0 <= iz < self.geom.nz_heat and 0 <= iy < self.geom.ny and 0 <= ix < self.geom.nx:
            gt = self._get_gt((z, y, x))
            p = self.geom.power_density[iz, iy, ix]
            return p / gt if gt > 0 else 0.0
        return 0.0

    def _get_gt(self, pos):
        g_dict = self.geom.get_conductance(pos)
        return sum(g_dict.values())




    def _estimate_local_time_increment(self, bc_type):
        epsilon = self.geom.boundary_epsilon[bc_type]
        delta = self.delta_x
        return (delta ** 2) / (6 * epsilon)

    def _step_wos(self, pos, radius = None):
        """
        改进后的 WOS 步骤：
        - 若处于上/下吸收带中，根据与边界的距离调整 r = Δx 或 2Δx
        - 否则计算从当前位置到有源区边界 & XY四周边界的最小值作为最大跳跃半径
        - 若落入虚拟网格区域，吸附到网格中心
        """
        z, y, x = pos
        region = self.geom.get_region_by_coord(z)

        if region not in ["top", "bottom"]:
            raise ValueError

        # -------------------------------
        # Case 1: 无源区：以有源区边界为限构建跳跃球
        # -------------------------------
        if radius is None:
            
            if region == 'top':
                z_upper = self.geom.z_top[1] * self.dz
                r_z = min(z - self.geom.z_heat[1] * self.dz, z_upper - z)
            else:
                z_lower = self.geom.z_bottom[0] * self.dz
                r_z = min(self.geom.z_heat[0] * self.dz - z, z - z_lower)

            # XY方向边界限制
            r_x = min(x, self.geom.x_size - x)
            r_y = min(y, self.geom.y_size - y)

            radius = min(r_x, r_y, r_z)
        else:
            # -------------------------------
            # Case 2: 吸收带中的 WOS 半径调整
            # -------------------------------
            pass  
            

        # -------------------------------
        # 球面上采样跳跃点
        # -------------------------------

        vec = np.random.normal(size=3)
        vec /= np.linalg.norm(vec)
        new_pos = pos + radius * vec
        
        new_pos = self._reflect(new_pos)

        # 如果落入虚拟区：吸附到网格中心
        new_region = self.geom.get_region_by_coord(new_pos[0])
        if new_region in ['virtual_top', 'virtual_bottom']:
            z_idx = int(new_pos[0] / self.dz)
            y_idx = int(new_pos[1] / self.dy)
            x_idx = int(new_pos[2] / self.dx)

            z_snap = (z_idx + 0.5) * self.dz
            y_snap = (y_idx + 0.5) * self.dy
            x_snap = (x_idx + 0.5) * self.dx

            return np.array([z_snap, y_snap, x_snap])

        return new_pos

    def _step_wog(self, pos):
        g_dict = self.geom.get_conductance(pos)
        total_g = sum(g_dict.values())

        directions = {
            '+x': np.array([0, 0, self.dx]),
            '-x': np.array([0, 0, -self.dx]),
            '+y': np.array([0, self.dy, 0]),
            '-y': np.array([0, -self.dy, 0]),
            '+z': np.array([self.dz, 0, 0]),
            '-z': np.array([-self.dz, 0, 0]),
        }

        probs = np.array([g_dict[dir] for dir in directions]) / total_g
        choice = np.random.choice(list(directions.keys()), p=probs)
        direction_vector = directions[choice]
        new_pos = pos + direction_vector

        # 若跳出 lateral 边界（XY方向），则反射
        _, y, x = new_pos
        if x < 0 or x > self.geom.x_size or y < 0 or y > self.geom.y_size:
            return self._reflect(new_pos)  # Neumann 反射

        return new_pos 


    def _reflect(self, pos):
        """
        将 pos 投影回合法区域：
        - 若 x, y 超出边界，则投影回最近合法边界
        - 若 z 超界，也回退至边界
        """
        z, y, x = pos
        x = min(max(x, 0), self.geom.x_size)
        y = min(max(y, 0), self.geom.y_size)
        z = min(max(z, 0), self.geom.nz_total * self.geom.z_resolution)
        return np.array([z, y, x])


