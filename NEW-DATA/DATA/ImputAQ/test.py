import pandas as pd

# Ruta del archivo CSV
ruta_csv = r"C:\Users\User\Downloads\TFAN-a-Attention-based-network-for-Air-Quality-Prediction\data\ImputAQ\air_quality_usa.csv"

# Leer el CSV
df = pd.read_csv(ruta_csv)

# Mostrar las primeras filas para verificar
print("Primeras filas del CSV:")
print(df.head(), "\n")

# Contar cuántos station_id únicos hay
station_unicos = df['station_id'].nunique()
print(f"Número de estaciones únicas: {station_unicos}\n")

# Contar cuántas filas hay de cada station_id
conteo_por_estacion = df['station_id'].value_counts()
print("Cantidad de registros por station_id:")
print(conteo_por_estacion)