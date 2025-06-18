import numpy as np
import math
import random
import os
import matplotlib.pyplot as plt

# --- Define the 3D chip geometry and material properties ---
Lx = 0.02  # Chip length in x-direction (20 mm)
Ly = 0.02  # Chip width in y-direction  (20 mm)
# Layer thicknesses:
t_top    = 0.0005   # Top heat-spreader thickness (0.5 mm)
t_heat   = 0.0001   # Heat-source region thickness (0.1 mm)
t_bottom = 0.0005   # Bottom substrate thickness (0.5 mm)
# z-coordinates of layer interfaces
z_bottom = 0.0                       # bottom surface at z=0
z_heat_bottom = z_bottom + t_bottom  # bottom of heat-source layer
z_heat_top    = z_heat_bottom + t_heat
z_top         = z_heat_top + t_top   # top surface of the chip

# Thermal conductivities (W/(m·K)) for each layer
k_substrate = 395.0   # e.g., copper substrate
k_heat      = 125.0   # e.g., silicon device layer
k_spreader  = 395.0   # e.g., copper heat spreader (same as substrate)

# Ambient temperature for convective boundaries (°C)
T_ambient = 20.0
# Fixed temperature for Dirichlet boundaries (°C)
T_fixed = 70.0

# Convective heat transfer coefficient for Robin boundaries (W/(m^2·K))
h_coeff = 8700.0  # default from Table I (Fourier heat transfer coefficient)

# Monte Carlo parameters
dt = 1e-9  # time step for Walk-on-Grid moves (s) – controls step size
max_steps = 100000  # safety cap on steps per particle path to prevent infinite loops

# --- Define boundary condition types for clarity ---
DIRICHLET = "Dirichlet"
NEUMANN   = "Neumann"
ROBIN     = "Robin"


# --- Define heat-source power maps (W/m^3) for each case --- 
Nx = 40  # grid resolution in x for power map
Ny = 40  # grid resolution in y

# Create coordinate grids for the power map
x_coords = np.linspace(0, Lx, Nx)
y_coords = np.linspace(0, Ly, Ny)

# Initialize power maps
power_map_4core1 = np.zeros((Ny, Nx))  # 4-core pattern (map 1)
power_map_4core2 = np.zeros((Ny, Nx))  # 4-core pattern (map 2, for stacking)
power_map_power6 = np.zeros((Ny, Nx))  # POWER6 pattern

# Define four core hotspot centers (approximately one per quadrant)
core_centers1 = [(0.005, 0.005), (0.015, 0.005), (0.005, 0.015), (0.015, 0.015)]
core_centers2 = [(0.006, 0.004), (0.014, 0.004), (0.007, 0.016), (0.013, 0.014)]  # slightly shifted for variety

# Helper to add a Gaussian hotspot to a power map
def add_hotspot(power_map, cx, cy, peak_power_density, sigma):
    """Add a Gaussian hotspot centered at (cx, cy) with given peak power density and standard deviation sigma."""
    for iy, y in enumerate(y_coords):
        for ix, x in enumerate(x_coords):
            # Gaussian distribution in plane
            dist2 = (x - cx)**2 + (y - cy)**2
            power_map[iy, ix] += peak_power_density * math.exp(-dist2 / (2 * sigma**2))

# Populate 4core maps with hotspots
for cx, cy in core_centers1:
    add_hotspot(power_map_4core1, cx, cy, peak_power_density=1.0, sigma=0.002)  # ~2 mm spread
for cx, cy in core_centers2:
    add_hotspot(power_map_4core2, cx, cy, peak_power_density=1.0, sigma=0.002)

# Populate POWER6 map with several random hotspots
random.seed(42)
for _ in range(6):  # assume 6 hotspots for POWER6
    cx = random.uniform(0.003, 0.017)
    cy = random.uniform(0.003, 0.017)
    add_hotspot(power_map_power6, cx, cy, peak_power_density=1.0, sigma=0.003)

# Normalize each power map to the same total power (e.g., 100 W total in device layer)
cell_area = (Lx / Nx) * (Ly / Ny)
layer_volume = cell_area * t_heat  # volume of one cell in heat layer
def normalize_power_map(pm, total_power_W):
    current_power = pm.sum() * layer_volume
    if current_power <= 0: 
        return pm
    return pm * (total_power_W / current_power)

power_map_4core1 = normalize_power_map(power_map_4core1, total_power_W=100.0)
power_map_4core2 = normalize_power_map(power_map_4core2, total_power_W=100.0)
power_map_power6 = normalize_power_map(power_map_power6, total_power_W=100.0)

# For stacked cases, we'll use 4core1 for one layer and 4core2 for the second layer.
# We assume each layer contributes half of the total power (50 W each) so that combined is 100 W.
power_map_stack_bottom = normalize_power_map(power_map_4core1, total_power_W=50.0)
power_map_stack_top    = normalize_power_map(power_map_4core2, total_power_W=50.0)


# --- Random walk for a single particle ---
def random_walk(start_x, start_y, start_z, topBC, bottomBC, power_map_bottom, power_map_top=None):
    """
    Perform one random walk path starting at (start_x, start_y, start_z).
    Returns the temperature contribution from this path (in °C).
    - topBC, bottomBC are boundary condition types ("Dirichlet", "Neumann", "Robin").
    - power_map_bottom: 2D array for heat generation in bottom part of heat region.
    - power_map_top: 2D array for heat generation in top part of heat region (if stacked), otherwise None.
    """
    # Initialize the particle at the start position
    x, y, z = start_x, start_y, start_z
    T_path = 0.0   # accumulative temperature contribution from sources along this path
    
    # Loop until particle is absorbed or max_steps reached
    for step in range(max_steps):
        # Determine material at current location to set thermal diffusivity if needed
        if z < z_heat_bottom:
            k_local = k_substrate   # bottom substrate
        elif z < z_heat_top:
            k_local = k_heat        # heat source region (silicon)
        else:
            k_local = k_spreader    # top heat spreader
        
        # --- Decide step mode: WOS or WOG ---
        # Compute distances to boundaries
        d_left   = x          # distance to left x=0
        d_right  = Lx - x     # distance to right boundary
        d_back   = y          # distance to y=0
        d_front  = Ly - y     # distance to y=Ly
        d_bottom = z - z_bottom    # distance to bottom surface
        d_top    = z_top - z       # distance to top surface
        dist_to_bound = min(d_left, d_right, d_back, d_front, d_bottom, d_top)
        
        # If far from all boundaries, use a Walk-on-Spheres step
        if dist_to_bound > 0.0002:  # threshold (e.g., 0.2 mm) for a "far" distance
            R = dist_to_bound  # radius to nearest boundary
            # Random direction on a sphere (isotropic)
            theta = math.acos(2*random.random() - 1) - math.pi/2   # polar angle
            phi = 2 * math.pi * random.random()                   # azimuthal angle
            # Spherical to Cartesian offset
            dx = R * math.cos(theta) * math.cos(phi)
            dy = R * math.cos(theta) * math.sin(phi)
            dz = R * math.sin(theta)
        else:
            # Use a small Brownian step (Walk-on-Grid)
            # We approximate thermal diffusivity D ~ k/(ρc) as constant for step size calculation.
            # For simplicity, treat D such that sqrt(2*D*dt) ~ sqrt(2*dt) (i.e., ρc normalized to 1).
            sigma = math.sqrt(2 * dt)
            dx = random.gauss(0, sigma)
            dy = random.gauss(0, sigma)
            dz = random.gauss(0, sigma)
        
        # Propose new position
        new_x = x + dx
        new_y = y + dy
        new_z = z + dz
        
        # --- Handle boundary crossings ---
        # Side boundaries (Neumann adiabatic on side walls)
        if new_x < 0.0:
            new_x = -new_x   # reflect inside
        elif new_x > Lx:
            new_x = 2*Lx - new_x
        if new_y < 0.0:
            new_y = -new_y
        elif new_y > Ly:
            new_y = 2*Ly - new_y
        
        # Bottom surface
        if new_z < z_bottom:
            # Particle crossed below bottom
            if bottomBC == DIRICHLET:
                # Absorbed at fixed temperature
                return T_fixed + T_path
            elif bottomBC == ROBIN:
                # Robin: decide absorption vs reflection based on convective strength
                # Compute an absorption probability ~ (h*area*dt)/C. We approximate by a fixed small p.
                p_absorb = min(1.0, h_coeff * dt / (k_local * 0.1))  # simple estimate of absorption probability
                if random.random() < p_absorb:
                    # Absorbed into convective sink at ambient temperature
                    return T_ambient + T_path
                else:
                    # Reflect the particle upward (Neumann-like reflection)
                    new_z = -new_z
            else:  # bottomBC == NEUMANN
                # Perfect reflection (adiabatic): mirror the position inside
                new_z = -new_z
        
        # Top surface
        if new_z > z_top:
            if topBC == DIRICHLET:
                return T_fixed + T_path
            elif topBC == ROBIN:
                p_absorb = min(1.0, h_coeff * dt / (k_local * 0.1))
                if random.random() < p_absorb:
                    return T_ambient + T_path
                else:
                    new_z = 2*z_top - new_z  # reflect inside
            else:  # topBC == NEUMANN
                new_z = 2*z_top - new_z
        
        # Update position after handling boundaries
        x, y, z = new_x, new_y, new_z
        
        # --- Accumulate heat source contribution (Feynman–Kac source term) ---
        if z_heat_bottom <= z <= z_heat_top:
            # Determine which power map to use (bottom or top half of device layer)
            # For stacked cases, we split the 0.1 mm layer into two 0.05 mm layers
            if power_map_top is None:
                Q_map = power_map_bottom
            else:
                mid_plane = (z_heat_bottom + z_heat_top) / 2.0
                Q_map = power_map_bottom if (z < mid_plane) else power_map_top
            # Find the indices of the cell in the power map corresponding to (x, y)
            ix = min(Nx-1, max(0, int((x / Lx) * Nx)))
            iy = min(Ny-1, max(0, int((y / Ly) * Ny)))
            Q_val = Q_map[iy, ix]  # power density in this cell (W/m^3)
            # Accumulate temperature rise from this segment: (Q/k) * dt
            T_path += (Q_val / k_local) * dt
        
    # If loop finishes without absorption (very rare due to max_steps),
    # treat as absorbed at ambient (particle wandered a long time).
    return T_ambient + T_path


# --- Simulate each case and visualize results ---
def simulate_case(case_name,
                  topBC,
                  bottomBC,
                  power_map_bottom,
                  power_map_top=None,
                  grid_points=15,
                  num_paths=2000,
                  save_path=None):
    """
    Monte Carlo simulate the temperature field for a given case.
    Returns a 2D array of temperatures for points in the heat-source layer.

    Parameters
    ----------
    case_name : str
        Identifier used in the output filename.
    topBC, bottomBC, power_map_bottom, power_map_top : arrays or callables
        Boundary conditions and power distributions.
    grid_points : int
        Resolution of the sampling grid across the chip surface.
    num_paths : int
        Number of random walk paths (particles) to sample per grid point.
    save_path : str or None
        Full path (including filename) where the figure will be written.
        If None, defaults to "./{case_name}_temperature.png".
    """
    temps = np.zeros((grid_points, grid_points))
    xs = np.linspace(0, Lx, grid_points)
    ys = np.linspace(0, Ly, grid_points)
    mid_z = (z_heat_bottom + z_heat_top) / 2.0  # sample at mid-thickness of heat layer

    for i, yy in enumerate(ys):
        for j, xx in enumerate(xs):
            T_sum = 0.0
            # Launch multiple random walks from this point to estimate T
            for _ in range(num_paths):
                T_sample = random_walk(xx, yy, mid_z,
                                        topBC, bottomBC,
                                        power_map_bottom,
                                        power_map_top)
                T_sum += T_sample
            temps[i, j] = T_sum / num_paths

    print(f"{case_name}: Simulation complete. "
          f"Estimated T range = {temps.min():.2f} to {temps.max():.2f} °C")

    # Plot heatmap of temperature distribution
    fig, ax = plt.subplots(figsize=(5, 4))
    cax = ax.imshow(temps,
                    origin='lower',
                    extent=[0, Lx*1000, 0, Ly*1000],
                    cmap='inferno')
    fig.colorbar(cax, label="Temperature (°C)", ax=ax)
    ax.set_title(f"{case_name} Temperature Distribution")
    ax.set_xlabel("x (mm)")
    ax.set_ylabel("y (mm)")
    fig.tight_layout()

    # Determine save path
    if save_path is None:
        filename = f"{case_name}_temperature.png"
        save_path = os.path.join(os.getcwd(), filename)
    # Save to disk and close figure
    fig.savefig(save_path, dpi=300)
    plt.close(fig)

    print(f"Figure saved to: {save_path}")
    return temps

# Run simulations for the four cases:
T_R4      = simulate_case("Case R4 (Robin–Robin)",   topBC=ROBIN,    bottomBC=ROBIN,    power_map_bottom=power_map_4core1)
T_Mix4    = simulate_case("Case Mix4 (Dirichlet–Robin)", topBC=DIRICHLET, bottomBC=ROBIN, power_map_bottom=power_map_4core1)
T_Stack1  = simulate_case("Case Stack-1 (Dirichlet–Robin, Stacked)", topBC=DIRICHLET, bottomBC=ROBIN,
                          power_map_bottom=power_map_stack_bottom, power_map_top=power_map_stack_top)
T_Stack2  = simulate_case("Case Stack-2 (Robin–Neumann, Stacked)",  topBC=ROBIN, bottomBC=NEUMANN,
                          power_map_bottom=power_map_stack_bottom, power_map_top=power_map_stack_top)
