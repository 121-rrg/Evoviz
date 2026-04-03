import os
import pandas as pd

base_path = r'D:\PROYECTO-PAPER\Evoviz\NEW-DATA\data_meteorologica'

file_list = []
for root, dirs, files in os.walk(base_path):
    for file in files:
        if file.endswith('.csv'):
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, base_path)
            file_list.append((rel_path, full_path))

for rel, full in file_list:
    print(f"{rel}")
