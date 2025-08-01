./cmdstan/bin/stanc HBMmodel.stan --o=model.hpp    
cd ./cmdstan
make ../model
cd ../
