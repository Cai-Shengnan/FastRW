cd /Users/zxwang/Documents/codes/ResRW
rm -rf build
mkdir build && cd build
cmake ..
make -j

DYLD_LIBRARY_PATH=../osqp-eigen/build ./random_walker

cd /Users/zxwang/Documents/codes/ResRW