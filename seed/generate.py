#!/usr/bin/env python3
"""Synthetic, deterministic data for AutoCare Türkiye (AutoCareHub v2).

Writes one PostgreSQL COPY text file per table (gzip) and a manifest into seed/out/,
which seed/load.sh loads.

    seed/.venv/bin/python seed/generate.py

Needs SEED_DEMO_PASSWORD (from the environment or the repo's .env): the six demo web logins
(DEMO_* below) get the bcrypt hash of that password; all other seeded logins cannot sign in. Same seed + same password -> byte-identical output.
All people, companies, phone numbers, e-mails, plates and tax numbers are synthetic.
"""
from __future__ import annotations

import bisect
import gzip
import heapq
import math
import os
import random
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import bcrypt
from faker import Faker

# ======================================================================= volumes
SEED = 20261117
PERIOD_START = date(2023, 1, 1)
PERIOD_END = date(2026, 11, 15)
AS_OF = datetime(2026, 11, 15, 18, 0)      # "now" for every status (Europe/Istanbul local time)
FUTURE_DAYS = 14                           # appointments already booked for the next two weeks
TZ_SUFFIX = "+03"                          # Türkiye is UTC+3 all year

N_CUSTOMERS = 25_000
FLEET_SHARE = 0.15
N_VEHICLES = 32_000
N_SUPPLIERS = 25
N_PARTS = 800                              # = sum of PART_KINDS counts
N_APPOINTMENTS = 200_000
N_WORK_ORDERS_WITHOUT_APPOINTMENT = 8_000  # tow-ins and rework
TARGET_REVIEWS = 40_000
LEGACY_CUSTOMER_SHARE = 0.30               # migrated from the old system, created before 2023

# ======================================================================= patterns
YEARLY_GROWTH = 0.15
PRICE_RISE = {2024: 1.55, 2025: 1.48, 2026: 1.42}  # January list-price factor (Turkish inflation)
VAT_CHANGE_ON, VAT_OLD_PCT, VAT_NEW_PCT = date(2023, 7, 10), 18, 20

MONTH_VOLUME = (0.85, 0.85, 1.00, 1.15, 1.10, 1.05, 0.95, 0.85, 1.00, 1.05, 1.15, 0.95)
SATURDAY_FACTOR = 0.7                      # Sundays closed
TYRE_SEASON = (0.5, 0.4, 1.2, 3.0, 1.4, 0.6, 0.5, 0.5, 0.7, 1.5, 3.2, 1.5)          # Apr + Nov peaks
AC_SEASON = (0.3, 0.3, 0.5, 1.0, 2.8, 3.2, 2.0, 1.4, 0.7, 0.4, 0.3, 0.3)            # May-Jun peak
AC_HOT_CITIES = ("Antalya", "Adana")
AC_HOT_CITY_EXTRA = (1.0, 1.0, 1.2, 1.5, 2.2, 2.4, 2.0, 1.8, 1.3, 1.0, 1.0, 1.0)
BATTERY_SEASON = (3.0, 2.0, 1.0, 0.7, 0.6, 0.6, 0.7, 0.7, 0.8, 1.0, 1.6, 3.0)       # Dec-Jan peak
WINTER_PREP_SEASON = (1.0, 0.8, 0.6, 0.5, 0.5, 0.5, 0.5, 0.5, 0.8, 1.8, 2.2, 1.6)
SUMMER_TRIP_SEASON = (0.5, 0.5, 0.6, 0.8, 1.0, 1.8, 2.2, 2.0, 0.8, 0.6, 0.5, 0.6)

CANKAYA = "ANK-CAN"                        # rating falls through 2026 with longer waits
CANKAYA_DECLINE_FROM = date(2026, 1, 1)
CANKAYA_TECHS_LEAVING = 3                  # leave Oct 2025 - Apr 2026, not replaced
CANKAYA_LEAD_DAYS_AT_END = 10.0            # mean wait for a slot (normal: ~2.5 days)
CANKAYA_DURATION_EXTRA = 1.5               # work orders take up to 2.5x as long
CANKAYA_RATING_DROP = 1.3
CANKAYA_VOLUME_DROP = 0.20
BORNOVA = "IZM-BOR"                        # best revenue per technician: high volume, lean staff

OVERDUE_FLEET_COUNT = 3                    # three fleet customers stop paying from May 2026
OVERDUE_FROM = date(2026, 5, 1)
BELOW_REORDER_PAIRS = 30                   # (branch, part) pairs whose supplier failed in autumn 2026
STOCK_BLOCK_FROM = datetime(2026, 9, 20)
FLEET_DISCOUNT_PCT = 5

# Only these web logins can sign in (bcrypt hash of SEED_DEMO_PASSWORD); every other seeded login gets
# password_hash NULL. Picked deterministically from the data (no random draws).
DEMO_CUSTOMERS = (("individual", "IST-KAD"), ("individual", "ANK-CAN"), ("fleet", "IZM-BOR"))
DEMO_BRANCH_ADMINS = ("IST-KAD", "ANK-CAN")          # the active branch manager of each
HQ_ADMIN_EMAIL = "hq.admin@autocare-turkiye.example"  # HQ admin: no employee row, sees all branches

# name, starts_on, ends_on, discount %, service category, demand factor while running
CAMPAIGNS = [
    ("Kış Lastiği Kampanyası 2023", date(2023, 11, 6), date(2023, 11, 26), 15, "tyres", 1.45),
    ("Bahar Klima Bakımı 2024", date(2024, 5, 6), date(2024, 5, 26), 20, "ac", 1.20),
    ("Yaz Lastiği Fırsatı 2024", date(2024, 4, 8), date(2024, 4, 21), 10, "tyres", 1.15),
    ("Fren Güvenliği Haftaları 2024", date(2024, 9, 9), date(2024, 9, 29), 10, "brakes", 1.15),
    ("Kış Lastiği Kampanyası 2024", date(2024, 11, 4), date(2024, 11, 24), 15, "tyres", 1.45),
    ("Akü Kontrol Kampanyası 2025", date(2025, 1, 6), date(2025, 1, 26), 10, "electrical", 1.10),
    ("Yaz Lastiği Fırsatı 2025", date(2025, 4, 7), date(2025, 4, 20), 10, "tyres", 1.15),
    ("Bahar Klima Bakımı 2025", date(2025, 5, 5), date(2025, 5, 25), 20, "ac", 1.20),
    ("Fren Güvenliği Haftaları 2025", date(2025, 9, 8), date(2025, 9, 28), 10, "brakes", 1.15),
    ("Kış Lastiği Kampanyası 2025", date(2025, 11, 3), date(2025, 11, 23), 15, "tyres", 1.45),
    ("Akü Kontrol Kampanyası 2026", date(2026, 1, 5), date(2026, 1, 25), 10, "electrical", 1.10),
    ("Yaz Lastiği Fırsatı 2026", date(2026, 4, 6), date(2026, 4, 19), 10, "tyres", 1.15),
    ("Bahar Klima Bakımı 2026", date(2026, 5, 4), date(2026, 5, 24), 20, "ac", 1.20),
    ("Kış Lastiği Kampanyası 2026", date(2026, 11, 2), date(2026, 11, 22), 15, "tyres", 1.45),
]

# ======================================================================= reference data
# code, name, city, district, opened_on, bays, volume weight, technicians, advisors, cashiers
BRANCHES = [
    ("IST-KAD", "AutoCare Kadıköy", "İstanbul", "Kadıköy", date(2012, 4, 2), 12, 1.25, 12, 3, 2),
    ("IST-BES", "AutoCare Beşiktaş", "İstanbul", "Beşiktaş", date(2014, 9, 15), 9, 1.00, 10, 3, 2),
    ("IST-UMR", "AutoCare Ümraniye", "İstanbul", "Ümraniye", date(2016, 3, 7), 12, 1.20, 12, 3, 2),
    ("ANK-CAN", "AutoCare Çankaya", "Ankara", "Çankaya", date(2013, 5, 20), 11, 1.15, 12, 3, 2),
    ("ANK-YEN", "AutoCare Yenimahalle", "Ankara", "Yenimahalle", date(2018, 10, 1), 8, 0.80, 8, 2, 1),
    ("IZM-BOR", "AutoCare Bornova", "İzmir", "Bornova", date(2015, 6, 1), 10, 1.25, 9, 2, 1),
    ("IZM-KAR", "AutoCare Karşıyaka", "İzmir", "Karşıyaka", date(2019, 2, 11), 8, 0.85, 9, 2, 1),
    ("ANT-MUR", "AutoCare Muratpaşa", "Antalya", "Muratpaşa", date(2017, 4, 3), 9, 0.90, 9, 2, 1),
    ("BUR-NIL", "AutoCare Nilüfer", "Bursa", "Nilüfer", date(2018, 3, 12), 9, 0.90, 9, 2, 1),
    ("KOC-IZM", "AutoCare İzmit", "Kocaeli", "İzmit", date(2020, 9, 7), 8, 0.80, 8, 2, 1),
    ("ADA-SEY", "AutoCare Seyhan", "Adana", "Seyhan", date(2021, 5, 3), 8, 0.80, 8, 2, 1),
    ("KON-SEL", "AutoCare Selçuklu", "Konya", "Selçuklu", date(2025, 3, 1), 7, 0.60, 6, 2, 1),
]
CITY_PLATE_CODE = {"İstanbul": "34", "Ankara": "06", "İzmir": "35", "Antalya": "07", "Bursa": "16",
                   "Kocaeli": "41", "Adana": "01", "Konya": "42"}
CITY_PHONE_AREA = {"İstanbul": "216", "Ankara": "312", "İzmir": "232", "Antalya": "242", "Bursa": "224",
                   "Kocaeli": "262", "Adana": "322", "Konya": "332"}
OTHER_PLATE_CODES = ("34", "06", "35", "07", "16", "41", "01", "42", "10", "09", "55", "61", "27", "33",
                     "20", "26", "45", "48", "54", "59")
PLATE_LETTERS = "ABCDEFGHIJKLMNOPRSTUVYZ"
MOBILE_PREFIXES = ("530", "531", "532", "533", "535", "536", "537", "538", "539", "541", "542", "543",
                   "544", "545", "546", "549", "551", "552", "553", "554", "555", "505", "506", "507")

# brand, model, weight individual, weight fleet, fuel mix, first model year, last model year
VEHICLE_MODELS = [
    ("Renault", "Clio", 9, 8, {"petrol": .5, "diesel": .3, "lpg": .15, "hybrid": .05}, 2008, 2026),
    ("Renault", "Megane", 6, 4, {"petrol": .45, "diesel": .5, "lpg": .05}, 2008, 2026),
    ("Renault", "Taliant", 3, 3, {"petrol": .7, "lpg": .3}, 2021, 2026),
    ("Renault", "Captur", 2, 1, {"petrol": .8, "hybrid": .2}, 2014, 2026),
    ("Fiat", "Egea", 10, 12, {"petrol": .35, "diesel": .4, "lpg": .15, "hybrid": .1}, 2015, 2026),
    ("Fiat", "Doblo", 3, 8, {"diesel": .85, "petrol": .15}, 2008, 2026),
    ("Fiat", "Linea", 2, 1, {"diesel": .6, "petrol": .2, "lpg": .2}, 2008, 2018),
    ("Toyota", "Corolla", 6, 6, {"hybrid": .5, "petrol": .4, "diesel": .1}, 2008, 2026),
    ("Toyota", "C-HR", 2, 1, {"hybrid": .9, "petrol": .1}, 2017, 2026),
    ("Toyota", "Yaris", 1.5, 1, {"hybrid": .6, "petrol": .4}, 2010, 2026),
    ("Volkswagen", "Golf", 3, 1, {"petrol": .6, "diesel": .4}, 2008, 2026),
    ("Volkswagen", "Passat", 3, 3, {"diesel": .8, "petrol": .2}, 2008, 2026),
    ("Volkswagen", "Polo", 3, 1.5, {"petrol": .7, "diesel": .3}, 2008, 2026),
    ("Volkswagen", "T-Roc", 1.5, .5, {"petrol": 1}, 2018, 2026),
    ("Volkswagen", "Caddy", 1, 5, {"diesel": .9, "petrol": .1}, 2008, 2026),
    ("Hyundai", "i20", 4, 2, {"petrol": .9, "lpg": .1}, 2009, 2026),
    ("Hyundai", "Tucson", 2, 1, {"petrol": .5, "diesel": .3, "hybrid": .2}, 2015, 2026),
    ("Hyundai", "Bayon", 1.5, .5, {"petrol": 1}, 2021, 2026),
    ("Ford", "Focus", 4, 3, {"diesel": .5, "petrol": .5}, 2008, 2025),
    ("Ford", "Transit Custom", .5, 7, {"diesel": 1}, 2012, 2026),
    ("Ford", "Transit Courier", 1, 5, {"diesel": .8, "petrol": .2}, 2014, 2026),
    ("Ford", "Puma", 1, .3, {"petrol": .6, "hybrid": .4}, 2020, 2026),
    ("Peugeot", "208", 2.5, 1, {"petrol": .7, "diesel": .3}, 2012, 2026),
    ("Peugeot", "2008", 2, 1, {"petrol": .7, "diesel": .3}, 2014, 2026),
    ("Peugeot", "3008", 2, 1.5, {"diesel": .5, "petrol": .4, "hybrid": .1}, 2010, 2026),
    ("Peugeot", "Rifter", .5, 4, {"diesel": 1}, 2018, 2026),
    ("Dacia", "Duster", 3, 2, {"diesel": .5, "petrol": .3, "lpg": .2}, 2010, 2026),
    ("Dacia", "Sandero", 2, 1, {"petrol": .6, "lpg": .4}, 2013, 2026),
    ("Honda", "Civic", 3, 1.5, {"petrol": .85, "lpg": .15}, 2008, 2026),
    ("Opel", "Corsa", 2, 1, {"petrol": .7, "diesel": .3}, 2008, 2026),
    ("Opel", "Astra", 2, 1.5, {"petrol": .5, "diesel": .5}, 2008, 2026),
    ("Citroen", "C3", 1.5, .5, {"petrol": .8, "diesel": .2}, 2010, 2026),
    ("Citroen", "C-Elysee", 1.5, 2, {"diesel": .6, "petrol": .2, "lpg": .2}, 2012, 2022),
    ("Skoda", "Octavia", 2, 2, {"petrol": .5, "diesel": .5}, 2008, 2026),
    ("Skoda", "Superb", 1, 1.5, {"diesel": .6, "petrol": .4}, 2010, 2026),
    ("BMW", "3 Serisi", 1.5, .8, {"diesel": .5, "petrol": .45, "hybrid": .05}, 2008, 2026),
    ("BMW", "5 Serisi", 1, .8, {"diesel": .6, "petrol": .35, "hybrid": .05}, 2008, 2026),
    ("Mercedes-Benz", "C Serisi", 1.5, .8, {"diesel": .5, "petrol": .45, "hybrid": .05}, 2008, 2026),
    ("Mercedes-Benz", "E Serisi", .8, .8, {"diesel": .6, "petrol": .4}, 2008, 2026),
    ("Mercedes-Benz", "Vito", .3, 3, {"diesel": 1}, 2008, 2026),
    ("Togg", "T10X", 2, .8, {"ev": 1}, 2023, 2026),
    ("Chery", "Tiggo 7 Pro", 1.2, .5, {"petrol": .85, "hybrid": .15}, 2023, 2026),
    ("Chery", "Tiggo 8 Pro", .6, .3, {"petrol": .9, "hybrid": .1}, 2023, 2026),
    ("BYD", "Atto 3", .5, .2, {"ev": 1}, 2023, 2026),
    ("BYD", "Seal U DM-i", .3, .1, {"hybrid": 1}, 2024, 2026),
    ("Tesla", "Model Y", .8, .3, {"ev": 1}, 2022, 2026),
    ("Nissan", "Qashqai", 2, 1, {"petrol": .6, "diesel": .4}, 2008, 2026),
    ("Kia", "Sportage", 1.5, .8, {"petrol": .5, "diesel": .3, "hybrid": .2}, 2010, 2026),
]

# Service catalogue: code, name, category, standard hours, 2023 list price (TRY), popularity, season,
# parts [(part kind, probability, (min qty, max qty))]. "oil" is a special kind (1 L or 4 L + 1 L).
S = None
SERVICES = [
    ("MNT-001", "Periyodik Bakım (10.000 km)", "maintenance", 1.5, 2300, 14, S, [("oil", 1, (1, 1)), ("oil_filter", 1, (1, 1)), ("air_filter", .5, (1, 1)), ("cabin_filter", .4, (1, 1))]),
    ("MNT-002", "Periyodik Bakım (20.000 km)", "maintenance", 2.0, 3200, 9, S, [("oil", 1, (1, 1)), ("oil_filter", 1, (1, 1)), ("air_filter", 1, (1, 1)), ("cabin_filter", 1, (1, 1)), ("fuel_filter", .5, (1, 1))]),
    ("MNT-003", "Büyük Bakım (60.000 km)", "maintenance", 4.0, 6500, 3, S, [("oil", 1, (1, 1)), ("oil_filter", 1, (1, 1)), ("air_filter", 1, (1, 1)), ("cabin_filter", 1, (1, 1)), ("fuel_filter", 1, (1, 1)), ("spark_plug", .6, (4, 4)), ("coolant", .5, (1, 2))]),
    ("MNT-004", "Motor Yağı ve Filtre Değişimi", "maintenance", 0.8, 1100, 8, S, [("oil", 1, (1, 1)), ("oil_filter", 1, (1, 1))]),
    ("MNT-005", "Hava Filtresi Değişimi", "maintenance", 0.3, 350, 2, S, [("air_filter", 1, (1, 1))]),
    ("MNT-006", "Polen Filtresi Değişimi", "maintenance", 0.3, 300, 2, S, [("cabin_filter", 1, (1, 1))]),
    ("MNT-007", "Yakıt Filtresi Değişimi", "maintenance", 0.6, 600, 1.5, S, [("fuel_filter", 1, (1, 1))]),
    ("MNT-008", "Buji Değişimi", "maintenance", 0.8, 700, 1.5, S, [("spark_plug", 1, (4, 4))]),
    ("MNT-009", "Antifriz Değişimi", "maintenance", 0.7, 650, 1.5, "winter", [("coolant", 1, (1, 2))]),
    ("MNT-010", "Şanzıman Yağı Değişimi", "maintenance", 1.2, 1200, 1, S, [("gear_oil", 1, (2, 3))]),
    ("MNT-011", "Triger Seti Değişimi", "maintenance", 4.5, 4800, 1, S, [("timing_kit", 1, (1, 1)), ("coolant", .5, (1, 1))]),
    ("MNT-012", "Silecek Değişimi", "maintenance", 0.2, 200, 2, "winter", [("wiper", 1, (2, 2))]),
    ("TYR-001", "Mevsimlik Lastik Değişimi (4 Lastik)", "tyres", 1.0, 900, 9, "tyre", [("tyre", .35, (4, 4))]),
    ("TYR-002", "Lastik Montaj ve Balans", "tyres", 0.8, 700, 4, "tyre", [("tyre", .5, (1, 2))]),
    ("TYR-003", "Rot Ayarı", "tyres", 0.8, 800, 4, S, [("tie_rod", .1, (1, 2)), ("control_arm", .05, (1, 1))]),
    ("TYR-004", "Rot-Balans Paketi", "tyres", 1.2, 1300, 3, "tyre", []),
    ("TYR-005", "Lastik Tamiri", "tyres", 0.4, 300, 2, S, []),
    ("TYR-006", "Lastik Oteli (Sezonluk Saklama)", "tyres", 0.3, 900, 2.5, "tyre", []),
    ("TYR-007", "Jant Düzeltme", "tyres", 1.0, 1200, 0.6, S, []),
    ("TYR-008", "TPMS Sensör Değişimi", "tyres", 0.6, 500, 0.4, S, [("tpms", 1, (1, 1))]),
    ("BRK-001", "Ön Fren Balatası Değişimi", "brakes", 1.0, 900, 5, S, [("pad_front", 1, (1, 1))]),
    ("BRK-002", "Arka Fren Balatası Değişimi", "brakes", 1.2, 950, 3, S, [("pad_rear", 1, (1, 1))]),
    ("BRK-003", "Ön Fren Diski Değişimi", "brakes", 1.5, 1300, 2, S, [("disc_front", 1, (2, 2)), ("pad_front", .8, (1, 1))]),
    ("BRK-004", "Arka Fren Diski Değişimi", "brakes", 1.6, 1350, 1.2, S, [("disc_rear", 1, (2, 2)), ("pad_rear", .8, (1, 1))]),
    ("BRK-005", "Fren Hidroliği Değişimi", "brakes", 0.7, 600, 2, S, [("brake_fluid", 1, (1, 1))]),
    ("BRK-006", "El Freni Ayarı", "brakes", 0.5, 400, 0.8, S, []),
    ("BRK-007", "ABS Sensör Değişimi", "brakes", 0.8, 700, 0.6, S, [("abs_sensor", 1, (1, 1))]),
    ("KLM-001", "Klima Gazı Dolumu", "ac", 0.8, 900, 4, "ac", [("refrigerant", 1, (1, 1))]),
    ("KLM-002", "Klima Bakımı ve Dezenfeksiyon", "ac", 1.0, 1000, 3, "ac", [("cabin_filter", .7, (1, 1)), ("refrigerant", .5, (1, 1))]),
    ("KLM-003", "Klima Kompresörü Onarımı", "ac", 3.5, 3500, 0.5, "ac", [("ac_compressor", .7, (1, 1))]),
    ("KLM-004", "Klima Kaçak Testi", "ac", 0.6, 500, 1.2, "ac", []),
    ("KLM-005", "Kabin Filtresi ve Klima Temizliği", "ac", 0.5, 550, 1.5, "ac", [("cabin_filter", 1, (1, 1))]),
    ("KLM-006", "Klima Kondenser Değişimi", "ac", 2.5, 2200, 0.4, "ac", [("condenser", 1, (1, 1))]),
    ("ELK-001", "Akü Değişimi", "electrical", 0.4, 300, 4, "battery", [("battery", 1, (1, 1))]),
    ("ELK-002", "Akü ve Şarj Sistemi Testi", "electrical", 0.4, 350, 2.5, "battery", []),
    ("ELK-003", "Marş Motoru Onarımı", "electrical", 2.0, 1800, 0.8, "winter", [("starter", .6, (1, 1))]),
    ("ELK-004", "Alternatör Onarımı", "electrical", 2.0, 1900, 0.8, S, [("alternator", .6, (1, 1))]),
    ("ELK-005", "Far Ampulü Değişimi", "electrical", 0.3, 200, 2, S, [("bulb", 1, (1, 2))]),
    ("ELK-006", "Far Ayarı", "electrical", 0.3, 250, 1, S, []),
    ("ELK-007", "Elektrik Arıza Tespiti", "electrical", 1.0, 900, 1.5, S, []),
    ("ELK-008", "Hibrit/EV Batarya Kontrolü", "electrical", 1.0, 1500, 0.5, S, []),
    ("MTR-001", "Motor Arıza Onarımı", "engine", 4.0, 3500, 2, S, [("gasket", .5, (1, 1))]),
    ("MTR-002", "Enjektör Temizliği", "engine", 1.5, 1400, 1.5, S, [("injector_cleaner", 1, (1, 1))]),
    ("MTR-003", "Turbo Onarımı", "engine", 5.0, 5000, 0.4, S, [("turbo", .5, (1, 1))]),
    ("MTR-004", "Debriyaj Seti Değişimi", "engine", 5.0, 4200, 1.2, S, [("clutch_kit", 1, (1, 1))]),
    ("MTR-005", "Conta Değişimi", "engine", 3.0, 2500, 1, S, [("gasket", 1, (1, 1))]),
    ("MTR-006", "Egzoz Onarımı", "engine", 1.5, 1300, 1, S, [("exhaust", .6, (1, 1))]),
    ("MTR-007", "DPF Temizliği", "engine", 2.0, 2500, 0.8, S, [("dpf_cleaner", 1, (1, 1))]),
    ("MTR-008", "Radyatör Değişimi", "engine", 2.0, 1600, 0.8, "summer", [("radiator", 1, (1, 1)), ("coolant", 1, (1, 2))]),
    ("KPR-001", "Pasta Cila ve Boya Koruma", "bodywork", 3.0, 2500, 2, S, [("polish", 1, (1, 1))]),
    ("KPR-002", "Lokal Boya", "bodywork", 5.0, 3500, 1.5, S, [("paint", 1, (1, 1))]),
    ("KPR-003", "Boyasız Göçük Düzeltme", "bodywork", 2.0, 1800, 1.5, S, []),
    ("KPR-004", "Cam Değişimi", "bodywork", 2.0, 1500, 1, S, [("windscreen", 1, (1, 1))]),
    ("KPR-005", "Tampon Onarımı", "bodywork", 3.0, 2200, 1, S, [("bumper", .4, (1, 1)), ("paint", .6, (1, 1))]),
    ("KPR-006", "Seramik Kaplama", "bodywork", 6.0, 6000, 0.5, S, [("ceramic", 1, (1, 1))]),
    ("TST-001", "Bilgisayarlı Arıza Tespiti", "diagnostics", 0.5, 600, 4, S, [("shock_absorber", .05, (2, 2))]),
    ("TST-002", "Ekspertiz (Alım Öncesi Kontrol)", "diagnostics", 1.5, 1800, 1.5, S, []),
    ("TST-003", "Muayene Öncesi Kontrol", "diagnostics", 0.7, 700, 2, S, []),
    ("TST-004", "Kış Bakım Kontrolü", "diagnostics", 0.6, 500, 1.5, "winter", []),
    ("TST-005", "Yol Öncesi Güvenlik Kontrolü", "diagnostics", 0.6, 500, 1.5, "summer", []),
]
DISCONTINUED_SERVICES = {"TYR-007": date(2024, 12, 31), "KPR-006": date(2025, 6, 30)}
ADD_ON_SERVICES = {"MNT-012": 3, "ELK-005": 2, "TST-001": 3, "MNT-006": 2, "BRK-005": 1.5, "TYR-003": 2,
                   "KLM-005": 1.5, "TST-003": 1, "MNT-005": 1.5, "ELK-002": 1}
ADD_ON_PROBABILITIES = (0.62, 0.32, 0.10)  # chance of a 1st, 2nd, 3rd extra service
SPECIALTY_FOR_CATEGORY = {"tyres": "tyres", "ac": "ac", "electrical": "electrical", "engine": "engine",
                          "bodywork": "bodywork"}

# Part kinds: kind, category, count, product name, brands, (min, max) 2026 price TRY, variant source
PART_KINDS = [
    ("oil_1l", "engine_oil", 30, "Motor Yağı 1 L", ("Castrol", "Shell", "Mobil", "Motul", "Total", "Petrol Ofisi", "Opet Fuchs", "Liqui Moly"), (420, 680), "oil"),
    ("oil_4l", "engine_oil", 30, "Motor Yağı 4 L", ("Castrol", "Shell", "Mobil", "Motul", "Total", "Petrol Ofisi", "Opet Fuchs", "Liqui Moly"), (1550, 2450), "oil"),
    ("oil_filter", "filters", 50, "Yağ Filtresi", ("Bosch", "Mann-Filter", "Mahle", "Filtron", "Purflux"), (240, 620), "fit"),
    ("air_filter", "filters", 45, "Hava Filtresi", ("Bosch", "Mann-Filter", "Mahle", "Filtron", "Purflux"), (290, 720), "fit"),
    ("cabin_filter", "filters", 40, "Polen Filtresi", ("Bosch", "Mann-Filter", "Mahle", "Filtron"), (240, 650), "fit"),
    ("fuel_filter", "filters", 35, "Yakıt Filtresi", ("Bosch", "Mann-Filter", "Mahle", "Filtron"), (380, 1150), "fit"),
    ("coolant", "fluids", 12, "Antifriz 3 L", ("Castrol", "Shell", "Petrol Ofisi", "Prestone", "Mobil", "Total"), (300, 520), "plain"),
    ("brake_fluid", "fluids", 8, "Fren Hidroliği DOT4 1 L", ("Bosch", "Castrol", "ATE", "Motul"), (260, 420), "plain"),
    ("gear_oil", "fluids", 12, "Şanzıman Yağı 1 L", ("Castrol", "Shell", "Motul", "Liqui Moly", "Total", "Mobil"), (480, 920), "plain"),
    ("injector_cleaner", "fluids", 6, "Enjektör Temizleyici", ("Liqui Moly", "Wynn's", "Bardahl"), (340, 620), "plain"),
    ("dpf_cleaner", "fluids", 4, "DPF Temizleme Sıvısı", ("Liqui Moly", "Wynn's"), (620, 920), "plain"),
    ("spark_plug", "engine", 20, "Buji", ("Bosch", "NGK", "Denso", "Champion"), (240, 880), "fit"),
    ("timing_kit", "engine", 20, "Triger Seti", ("Gates", "Contitech", "INA", "SKF"), (6000, 15500), "fit"),
    ("clutch_kit", "engine", 20, "Debriyaj Seti", ("Valeo", "Sachs", "LuK"), (9000, 22500), "fit"),
    ("gasket", "engine", 15, "Silindir Kapak Contası", ("Elring", "Victor Reinz", "Corteco"), (800, 3100), "fit"),
    ("turbo", "engine", 8, "Turbo Şarj Ünitesi", ("Garrett", "BorgWarner", "Mitsubishi"), (25000, 56000), "fit"),
    ("radiator", "engine", 15, "Radyatör", ("Valeo", "Nissens", "Behr Hella"), (5000, 12500), "fit"),
    ("exhaust", "engine", 12, "Egzoz Susturucu", ("Bosal", "Walker", "Ernst"), (4000, 12000), "fit"),
    ("wiper", "wipers", 25, "Silecek Süpürgesi", ("Bosch", "Valeo", "Michelin", "Hella"), (290, 920), "wiper"),
    ("tyre_summer", "tyres", 45, "Yaz Lastiği", ("Michelin", "Bridgestone", "Continental", "Pirelli", "Goodyear", "Lassa", "Petlas", "Hankook", "Starmaxx"), (2800, 8800), "tyre"),
    ("tyre_winter", "tyres", 45, "Kış Lastiği", ("Michelin", "Bridgestone", "Continental", "Pirelli", "Goodyear", "Lassa", "Petlas", "Hankook", "Starmaxx"), (3000, 9400), "tyre"),
    ("tyre_allseason", "tyres", 20, "4 Mevsim Lastik", ("Michelin", "Goodyear", "Lassa", "Bridgestone", "Petlas"), (3100, 9000), "tyre"),
    ("tpms", "tyres", 8, "TPMS Basınç Sensörü", ("Schrader", "VDO", "Huf"), (1800, 3600), "plain"),
    ("pad_front", "brakes", 35, "Ön Fren Balata Seti", ("Bosch", "Brembo", "TRW", "Ferodo", "Textar"), (1450, 4100), "fit"),
    ("pad_rear", "brakes", 25, "Arka Fren Balata Seti", ("Bosch", "Brembo", "TRW", "Ferodo", "Textar"), (1200, 3300), "fit"),
    ("disc_front", "brakes", 20, "Ön Fren Diski", ("Bosch", "Brembo", "TRW", "Zimmermann"), (2500, 6600), "fit"),
    ("disc_rear", "brakes", 15, "Arka Fren Diski", ("Bosch", "Brembo", "TRW", "Zimmermann"), (2000, 5600), "fit"),
    ("abs_sensor", "brakes", 10, "ABS Sensörü", ("Bosch", "ATE", "Febi"), (1200, 3100), "fit"),
    ("refrigerant", "ac", 4, "Klima Gazı", ("Honeywell", "Chemours"), (1500, 3600), "gas"),
    ("ac_compressor", "ac", 10, "Klima Kompresörü", ("Denso", "Sanden", "Valeo"), (15000, 35500), "fit"),
    ("condenser", "ac", 10, "Klima Kondenseri", ("Nissens", "Valeo", "Behr Hella"), (5000, 11500), "fit"),
    ("battery", "battery", 30, "Akü", ("Mutlu", "Varta", "Bosch", "İnci", "Yiğit Akü"), (3400, 9800), "battery"),
    ("bulb", "electrical", 20, "Far Ampulü", ("Philips", "Osram", "Narva"), (150, 1250), "bulb"),
    ("starter", "electrical", 10, "Marş Motoru", ("Bosch", "Valeo", "Denso"), (6000, 14500), "fit"),
    ("alternator", "electrical", 10, "Alternatör", ("Bosch", "Valeo", "Denso"), (8000, 18500), "fit"),
    ("polish", "bodywork", 5, "Pasta Cila Seti", ("3M", "Meguiar's", "Sonax"), (600, 1550), "plain"),
    ("paint", "bodywork", 10, "Oto Boya ve Vernik Seti", ("Glasurit", "Standox", "Sikkens", "Spies Hecker"), (2500, 6100), "plain"),
    ("windscreen", "bodywork", 10, "Ön Cam", ("Şişecam", "Saint-Gobain", "Pilkington"), (6000, 16500), "fit"),
    ("bumper", "bodywork", 12, "Ön Tampon", ("OEM Muadil", "Blic", "Van Wezel"), (4000, 12500), "fit"),
    ("ceramic", "bodywork", 3, "Seramik Kaplama Seti", ("Gtechniq", "Gyeon", "CarPro"), (3000, 7200), "plain"),
    ("shock_absorber", "suspension", 16, "Amortisör", ("Sachs", "Monroe", "KYB", "Bilstein"), (2500, 7100), "fit"),
    ("tie_rod", "suspension", 12, "Rot Başı", ("Lemförder", "TRW", "Febi"), (800, 2250), "fit"),
    ("control_arm", "suspension", 8, "Salıncak", ("Lemförder", "TRW", "Febi"), (2000, 5600), "fit"),
]
PART_FITMENTS = ("Renault Clio / Symbol", "Renault Megane", "Fiat Egea", "Fiat Doblo", "Toyota Corolla",
                 "VW Golf / Jetta", "VW Passat", "VW Polo", "VW Caddy", "Hyundai i20", "Hyundai Tucson",
                 "Ford Focus", "Ford Transit Custom", "Ford Courier", "Peugeot 208 / 2008", "Peugeot 3008",
                 "Dacia Duster", "Honda Civic", "Opel Astra", "Opel Corsa", "Skoda Octavia",
                 "BMW 3 / 5 Serisi", "Mercedes C / E Serisi", "Mercedes Vito", "Togg T10X", "Chery Tiggo")
OIL_GRADES = ("0W-20", "0W-30", "5W-30", "5W-40", "10W-40")
TYRE_SIZES = ("175/65 R14", "185/65 R15", "195/65 R15", "195/55 R16", "205/55 R16", "215/55 R17",
              "215/60 R16", "225/45 R17", "225/50 R18", "235/55 R18", "215/65 R16C")
BATTERY_SIZES = ("45 Ah", "60 Ah", "60 Ah EFB", "72 Ah", "72 Ah AGM", "90 Ah", "100 Ah")
BULB_TYPES = ("H1", "H4", "H7", "H11", "LED H7")
WIPER_SIZES = ("400 mm", "450 mm", "500 mm", "550 mm", "600 mm", "650 mm")

SUPPLIER_CATEGORIES = [  # each supplier covers these part categories
    ("engine_oil", "fluids"), ("filters", "engine_oil"), ("tyres",), ("tyres",), ("battery", "electrical"),
    ("brakes", "suspension"), ("brakes",), ("engine",), ("engine", "filters"), ("ac", "electrical"),
    ("bodywork",), ("bodywork", "wipers"), ("suspension", "engine"), ("electrical", "battery"),
    ("filters", "wipers", "fluids"), ("tyres", "suspension"), ("engine_oil", "fluids", "filters"),
    ("ac",), ("brakes", "filters"), ("engine", "electrical"), ("battery",), ("wipers", "electrical"),
    ("bodywork", "fluids"), ("engine", "ac"), ("filters", "brakes", "engine_oil"),
]
SUPPLIER_CITIES = ("İstanbul", "İstanbul", "İstanbul", "Ankara", "İzmir", "Bursa", "Kocaeli", "Konya")
COMPANY_SECTORS = ("Lojistik", "Nakliyat", "Turizm", "Gıda", "İnşaat", "Tekstil", "Filo Kiralama",
                   "Dağıtım", "Medikal", "Enerji", "Tarım Ürünleri", "Kargo", "Temizlik Hizmetleri",
                   "Güvenlik Hizmetleri", "Mobilya", "Ambalaj", "Elektrik", "Yapı Market", "Catering")
COMPANY_SUFFIXES = ("A.Ş.", "Ltd. Şti.", "San. ve Tic. A.Ş.", "Tic. Ltd. Şti.")
EMAIL_DOMAINS = ("example.com", "example.net", "example.org")
STAFF_EMAIL_DOMAIN = "autocare-turkiye.example"

APPOINTMENT_NOTES = {
    "maintenance": ("Periyodik bakım zamanı geldi.", "Yağ değişimi istiyorum.", "Bakım ışığı yandı.",
                    "Bakım sonrası araç yıkanırsa sevinirim."),
    "tyres": ("Lastiklerim lastik otelinde duruyor, değişim yapılacak.", "Mevsimlik lastik değişimi.",
              "Direksiyonda titreme var, balans yaptırmak istiyorum.", "Yeni lastik fiyatı alabilir miyim?"),
    "brakes": ("Fren yaparken ses geliyor.", "Fren pedalı yumuşadı.", "Balata uyarısı yanıyor."),
    "ac": ("Klima soğuk üflemiyor.", "Klimadan kötü koku geliyor.", "Klima gazı kontrolü istiyorum."),
    "electrical": ("Araç sabahları zor çalışıyor, akü olabilir.", "Far ampulü yanmıyor.",
                   "Göstergede akü uyarısı var."),
    "engine": ("Motor arıza lambası yanıyor.", "Rölantide tekleme var.", "Egzozdan duman geliyor.",
               "Debriyaj kaçırıyor."),
    "bodywork": ("Kapıda küçük bir göçük var.", "Arka tamponda çizik var.", "Ön camda çatlak oluştu."),
    "diagnostics": ("Araç almadan önce ekspertiz istiyorum.", "Muayene öncesi kontrol rica ediyorum.",
                    "Uzun yola çıkmadan kontrol ettirmek istiyorum."),
}
FLEET_NOTES = ("Filo aracı, fatura şirkete kesilecek.", "Aynı gün teslim gerekiyor.",
               "Sürücü aracı bırakıp gidecek.")
REVIEW_COMMENTS = {
    5: ("Çok memnun kaldım, teşekkürler.", "Hızlı ve temiz iş çıkardılar.", "Servis danışmanı çok ilgiliydi.",
        "Fiyat/performans gayet iyi.", "Araç zamanında teslim edildi."),
    4: ("Genel olarak memnunum.", "İşçilik iyi ama biraz bekledim.", "Fiyatlar biraz yüksek ama hizmet kaliteli.",
        "Güler yüzlü personel."),
    3: ("Ortalama bir deneyimdi.", "İş yapıldı ama iletişim zayıftı.", "Teslim süresi uzundu.",
        "Fiyat beklediğimden yüksek çıktı."),
    2: ("Araç söz verilen saatte teslim edilmedi.", "Randevu almak çok uzun sürdü.", "Aynı sorun tekrar etti.",
        "Bilgilendirme yapılmadı."),
    1: ("Çok kötü bir deneyim, bir daha gelmem.", "Randevu için günlerce bekledim, araç da geç teslim edildi.",
        "Telefonlara cevap verilmiyor.", "Faturada beklenmedik kalemler vardı."),
}
WAIT_COMPLAINTS = ("Randevu için neredeyse iki hafta bekledim.", "Usta sayısı yetersiz, araç günlerce serviste kaldı.",
                   "Şube eskisi gibi değil, her şey çok yavaş.", "Söz verilen teslim tarihi iki kez ertelendi.")

OUT_DIR = Path(__file__).resolve().parent / "out"
REPO_DIR = Path(__file__).resolve().parent.parent

# ======================================================================= helpers
R = random.Random(SEED)
FAKE = Faker("tr_TR")
FAKE.seed_instance(SEED)
WORKDAY_START, WORKDAY_END = 8.5, 18.5  # hours


def poisson(lam: float) -> int:
    threshold, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= R.random()
        if p <= threshold:
            return k
        k += 1


def at(d: date, hours: float) -> datetime:
    return datetime(d.year, d.month, d.day) + timedelta(minutes=round(hours * 60))


def rand_time(start: datetime, end: datetime) -> datetime:
    return start + timedelta(seconds=R.randint(0, max(0, int((end - start).total_seconds()))))


def add_work_hours(t: datetime, hours: float) -> datetime:
    """Advance t by working hours (08:30-18:30, Monday-Saturday)."""
    while True:
        day_end = at(t.date(), WORKDAY_END)
        left = (day_end - t).total_seconds() / 3600
        if hours <= left:
            return t + timedelta(minutes=round(hours * 60))
        hours -= max(left, 0)
        nxt = t.date() + timedelta(days=1)
        if nxt.weekday() == 6:
            nxt += timedelta(days=1)
        t = at(nxt, WORKDAY_START)


def progress(d: date, start: date, end: date = PERIOD_END) -> float:
    if d <= start:
        return 0.0
    return min(1.0, (d - start).days / (end - start).days)


def ascii_slug(text: str) -> str:
    table = str.maketrans("çğıöşüÇĞİÖŞÜâîû", "cgiosuCGIOSUaiu")
    return "".join(ch for ch in text.translate(table).lower() if ch.isalnum() or ch in ".-")


def weighted_index(cum: list[float]) -> int:
    return bisect.bisect_right(cum, R.random() * cum[-1])


def cumulative(weights) -> list[float]:
    out, acc = [], 0.0
    for w in weights:
        acc += w
        out.append(acc)
    return out


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


def cents(try_amount: float) -> int:
    return int(round(try_amount * 100))


def price_index(year: int) -> float:
    idx = 1.0
    for y in range(2024, year + 1):
        idx *= PRICE_RISE[y]
    return idx


def vat_pct(d: date) -> int:
    return VAT_OLD_PCT if d < VAT_CHANGE_ON else VAT_NEW_PCT


def invalid_vkn() -> str:
    """10 digits whose check digit is deliberately wrong, so it can never be a real tax number."""
    digits = [R.randint(0, 9) for _ in range(9)]
    digits[0] = R.randint(1, 9)
    total = 0
    for i, d in enumerate(digits):
        tmp = (d + 9 - i) % 10
        v = (tmp * 2 ** (9 - i)) % 9
        if tmp != 0 and v == 0:
            v = 9
        total += v
    check = (10 - total % 10) % 10
    return "".join(map(str, digits)) + str((check + 1 + R.randint(0, 8)) % 10)


def plate(city_code: str, used: set[str]) -> str:
    while True:
        n_letters = R.choice((1, 2, 2, 3, 3, 3))
        letters = "".join(R.choice(PLATE_LETTERS) for _ in range(n_letters))
        if n_letters == 1:
            digits = str(R.randint(1000, 9999))
        elif n_letters == 2:
            digits = str(R.randint(100, 9999))
        else:
            digits = str(R.randint(10, 999)).zfill(2)
        p = f"{city_code} {letters} {digits}"
        if p not in used:
            used.add(p)
            return p


def mobile_phone() -> str:
    n = f"{R.randint(0, 9999999):07d}"
    return f"+90 {R.choice(MOBILE_PREFIXES)} {n[:3]} {n[3:5]} {n[5:]}"


class Ctx:
    """Everything generated so far; tables are lists of tuples in COPY column order."""

    def __init__(self) -> None:
        self.tables: dict[str, tuple[list[str], list[tuple]]] = {}

    def table(self, name: str, columns: list[str]) -> list[tuple]:
        rows: list[tuple] = []
        self.tables[name] = (columns, rows)
        return rows


# ======================================================================= branches & employees
def build_branches_and_employees(ctx: Ctx) -> None:
    ctx.branches = []
    for i, (code, name, city, district, opened, bays, weight, techs, advisors, cashiers) in enumerate(BRANCHES):
        ctx.branches.append(dict(id=i + 1, idx=i, code=code, name=name, city=city, district=district,
                                 opened_on=opened, bays=bays, weight=weight, techs=techs,
                                 advisors=advisors, cashiers=cashiers))
    ctx.branch_by_code = {b["code"]: b for b in ctx.branches}
    ctx.city_branches = defaultdict(list)
    for b in ctx.branches:
        ctx.city_branches[b["city"]].append(b)

    employees: list[dict] = []
    used_emails: set[str] = set()
    tech_specialties = ["general"] * 40 + ["engine"] * 15 + ["electrical"] * 12 + ["tyres"] * 13 + \
                       ["bodywork"] * 10 + ["ac"] * 10
    salary = {"manager": (110_000, 160_000), "service_advisor": (48_000, 70_000),
              "technician": (42_000, 68_000), "cashier": (36_000, 44_000)}

    def person(branch: dict, role: str, specialty: str | None, hired: date, left: date | None) -> dict:
        first, last = FAKE.first_name(), FAKE.last_name()
        base = f"{ascii_slug(first)}.{ascii_slug(last)}"
        email, n = f"{base}@{STAFF_EMAIL_DOMAIN}", 2
        while email in used_emails:
            email, n = f"{base}{n}@{STAFF_EMAIL_DOMAIN}", n + 1
        used_emails.add(email)
        lo, hi = salary[role]
        e = dict(id=len(employees) + 1, branch=branch, full_name=f"{first} {last}", role=role,
                 specialty=specialty, hired_on=hired, left_on=left,
                 salary=round(R.uniform(lo, hi), -2), email=email)
        employees.append(e)
        return e

    for b in ctx.branches:
        if b["opened_on"] >= PERIOD_START:
            first_hire = (b["opened_on"] - timedelta(days=55), b["opened_on"] - timedelta(days=5))
        else:
            first_hire = (b["opened_on"], date(2022, 12, 15))
        specs = [tech_specialties[R.randrange(len(tech_specialties))] for _ in range(b["techs"])]
        specs[0], specs[1] = "tyres", "ac"           # every branch can do tyres and AC
        positions = [("manager", None)] + [("service_advisor", None)] * b["advisors"] + \
                    [("technician", s) for s in specs] + [("cashier", None)] * b["cashiers"]
        leaving_techs = set()
        if b["code"] == CANKAYA:
            leaving_techs = set(R.sample(range(2, b["techs"]), CANKAYA_TECHS_LEAVING))
        tech_no = 0
        for pos, (role, spec) in enumerate(positions):
            hired = first_hire[0] + timedelta(days=R.randint(0, (first_hire[1] - first_hire[0]).days))
            if role == "technician":
                tech_no += 1
            if role == "technician" and tech_no in leaving_techs:
                left = rand_time(at(date(2025, 10, 15), 0), at(date(2026, 4, 30), 0)).date()
                person(b, role, spec, hired, left)
                continue
            if R.random() < 0.08 and hired < date(2026, 3, 1):
                lo = max(hired + timedelta(days=120), date(2023, 3, 1))
                left = lo + timedelta(days=R.randint(0, max(0, (date(2026, 9, 30) - lo).days)))
                person(b, role, spec, hired, left)
                gap = 1 if role in ("manager", "service_advisor") else R.randint(10, 40)
                person(b, role, spec, left + timedelta(days=gap), None)
            else:
                person(b, role, spec, hired, None)
    ctx.employees = employees
    for b in ctx.branches:
        staff = [e for e in employees if e["branch"] is b]
        b["staff"] = staff
        managers = [e for e in staff if e["role"] == "manager" and e["left_on"] is None]
        b["manager_id"] = managers[0]["id"]
    ctx.active_cache = {}

    rows = ctx.table("branches", ["id", "code", "name", "city", "district", "opened_on", "closed_on",
                                  "manager_employee_id", "bay_count"])
    for b in ctx.branches:
        rows.append((b["id"], b["code"], b["name"], b["city"], b["district"], b["opened_on"], None,
                     b["manager_id"], b["bays"]))
    rows = ctx.table("employees", ["id", "branch_id", "full_name", "role", "specialty", "hired_on", "left_on",
                                   "monthly_salary_try", "email"])
    for e in employees:
        rows.append((e["id"], e["branch"]["id"], e["full_name"], e["role"], e["specialty"], e["hired_on"],
                     e["left_on"], money(cents(e["salary"])), e["email"]))


def active_staff(ctx: Ctx, branch: dict, d: date) -> dict[str, list[dict]]:
    key = (branch["idx"], d)
    hit = ctx.active_cache.get(key)
    if hit is None:
        hit = defaultdict(list)
        for e in branch["staff"]:
            if e["hired_on"] <= d and (e["left_on"] is None or e["left_on"] >= d):
                hit[e["role"]].append(e)
        ctx.active_cache[key] = hit
    return hit


# ======================================================================= catalogue, prices, campaigns
def build_catalog(ctx: Ctx) -> None:
    ctx.services = []
    rows = ctx.table("service_catalog", ["id", "code", "name", "category", "standard_labor_hours", "active"])
    prices = ctx.table("service_prices", ["service_id", "valid_from", "valid_to", "list_price_try"])
    for i, (code, name, cat, hours, base_price, weight, season, parts) in enumerate(SERVICES):
        until = DISCONTINUED_SERVICES.get(code)
        s = dict(id=i + 1, code=code, name=name, category=cat, hours=hours, weight=weight, season=season,
                 parts=parts, until=until, price={})
        price = base_price
        for year in range(2023, 2027):
            if year > 2023:
                price *= PRICE_RISE[year] * R.uniform(0.96, 1.04)
            if until and date(year, 1, 1) > until:
                break
            s["price"][year] = int(round(price / 10)) * 1000          # list prices end in 0 TRY
            valid_to = date(year, 12, 31) if year < 2026 else None
            if until and until.year == year:
                valid_to = until
            prices.append((s["id"], date(year, 1, 1), valid_to, money(s["price"][year])))
        rows.append((s["id"], code, name, cat, f"{hours:.2f}", until is None))
        ctx.services.append(s)
    ctx.service_by_code = {s["code"]: s for s in ctx.services}

    ctx.campaigns = []
    rows = ctx.table("campaigns", ["id", "name", "starts_on", "ends_on", "discount_pct", "service_category"])
    for i, (name, start, end, pct, cat, factor) in enumerate(CAMPAIGNS):
        ctx.campaigns.append(dict(id=i + 1, start=start, end=end, pct=pct, category=cat, factor=factor))
        rows.append((i + 1, name, start, end, f"{pct:.2f}", cat))
    ctx.mix_cache = {}


def season_factor(season: str | None, month: int, city: str) -> float:
    m = month - 1
    if season == "tyre":
        return TYRE_SEASON[m]
    if season == "ac":
        f = AC_SEASON[m]
        return f * AC_HOT_CITY_EXTRA[m] * 1.4 if city in AC_HOT_CITIES else f
    if season == "battery":
        return BATTERY_SEASON[m]
    if season == "winter":
        return WINTER_PREP_SEASON[m]
    if season == "summer":
        return SUMMER_TRIP_SEASON[m]
    return 1.0


def service_mix(ctx: Ctx, city: str, d: date) -> tuple[list[dict], list[float], dict]:
    """Services available on day d with their seasonal / campaign weights (cached)."""
    running = tuple(c["id"] for c in ctx.campaigns if c["start"] <= d <= c["end"])
    key = (city, d.month, running, d.year)
    hit = ctx.mix_cache.get(key)
    if hit is None:
        boost = {c["category"]: c for c in ctx.campaigns if c["id"] in running}
        svcs = [s for s in ctx.services if d.year in s["price"] and (s["until"] is None or d <= s["until"])]
        weights = []
        for s in svcs:
            w = s["weight"] * season_factor(s["season"], d.month, city)
            if s["category"] in boost:
                w *= boost[s["category"]]["factor"]
            weights.append(w)
        hit = (svcs, cumulative(weights), boost)
        ctx.mix_cache[key] = hit
    return hit


# ======================================================================= parts & suppliers
def build_parts_and_suppliers(ctx: Ctx) -> None:
    assert sum(k[2] for k in PART_KINDS) == N_PARTS
    ctx.parts, ctx.parts_by_kind = [], defaultdict(list)
    for kind, cat, count, product, brands, (lo, hi), variant in PART_KINDS:
        combos = []
        for brand in brands:
            if variant == "oil":
                combos += [(brand, g) for g in OIL_GRADES]
            elif variant == "fit":
                combos += [(brand, f) for f in PART_FITMENTS]
            elif variant == "tyre":
                combos += [(brand, s) for s in TYRE_SIZES]
            elif variant == "battery":
                combos += [(brand, s) for s in BATTERY_SIZES]
            elif variant == "bulb":
                combos += [(brand, s) for s in BULB_TYPES]
            elif variant == "wiper":
                combos += [(brand, s) for s in WIPER_SIZES]
            elif variant == "gas":
                combos += [(brand, g) for g in ("R134a 1 kg", "R1234yf 1 kg")]
            else:
                combos += [(brand, v) for v in ("", "Premium", "Pro", "Eco")]
        R.shuffle(combos)
        chosen = combos[:count]
        while len(chosen) < count:      # not enough combinations: repeat with a pack variant
            b, v = combos[len(chosen) % len(combos)]
            chosen.append((b, f"{v} (2'li paket)".strip()))
        brand_premium = {b: R.uniform(0.85, 1.2) for b in brands}
        for rank, (brand, var) in enumerate(chosen):
            price = min(hi, max(lo, R.uniform(lo, hi) * brand_premium[brand]))
            price_c = int(round(price)) * 100
            cost_c = int(price_c * R.uniform(0.62, 0.78))
            name = " ".join(x for x in (brand, product, var) if x)
            p = dict(id=len(ctx.parts) + 1, sku=f"{cat[:3].upper()}-{len(ctx.parts) + 1:05d}", name=name,
                     category=cat, kind=kind, brand=brand, price_c=price_c, cost_c=cost_c,
                     popularity=1.0 / (rank + 1) ** 1.1)
            ctx.parts.append(p)
            ctx.parts_by_kind[kind].append(p)
    ctx.kind_cum = {k: cumulative(p["popularity"] for p in v) for k, v in ctx.parts_by_kind.items()}

    ctx.suppliers = []
    used = set()
    for i in range(N_SUPPLIERS):
        while True:
            name = f"{FAKE.last_name()} Otomotiv Yedek Parça {R.choice(COMPANY_SUFFIXES)}"
            if name not in used:
                used.add(name)
                break
        ctx.suppliers.append(dict(id=i + 1, name=name, city=R.choice(SUPPLIER_CITIES),
                                  lead=R.choice((1, 1, 2, 2, 2, 3, 3, 4, 5, 7)),
                                  cats=SUPPLIER_CATEGORIES[i]))
    rows = ctx.table("suppliers", ["id", "name", "city", "lead_time_days"])
    for s in ctx.suppliers:
        rows.append((s["id"], s["name"], s["city"], s["lead"]))

    links = ctx.table("part_suppliers", ["part_id", "supplier_id", "is_primary"])
    for p in ctx.parts:
        cands = [s for s in ctx.suppliers if p["category"] in s["cats"]]
        chosen = R.sample(cands, min(len(cands), R.choice((1, 2, 2, 3))))
        p["supplier"] = chosen[0]
        for j, s in enumerate(chosen):
            links.append((p["id"], s["id"], j == 0))


def pick_part(ctx: Ctx, kind: str) -> dict:
    return ctx.parts_by_kind[kind][weighted_index(ctx.kind_cum[kind])]


# ======================================================================= customers & vehicles
def build_customers_and_vehicles(ctx: Ctx) -> None:
    branch_cum = cumulative(b["weight"] for b in ctx.branches)
    n_fleet = round(N_CUSTOMERS * FLEET_SHARE)
    fleet_flags = [True] * n_fleet + [False] * (N_CUSTOMERS - n_fleet)
    R.shuffle(fleet_flags)
    used_emails, used_companies, used_plates = set(), set(), set()
    customers = []
    for i, is_fleet in enumerate(fleet_flags):
        b = ctx.branches[weighted_index(branch_cum)]
        if b["opened_on"] >= PERIOD_START:
            created = rand_time(at(b["opened_on"] - timedelta(days=40), 9), AS_OF - timedelta(days=30))
        elif R.random() < LEGACY_CUSTOMER_SHARE:
            created = rand_time(datetime(2019, 1, 2, 9), datetime(2022, 12, 30, 18))
        else:  # growing intake: density rises ~15% a year
            u = R.random()
            span = (AS_OF - timedelta(days=30) - datetime(2023, 1, 2)).total_seconds()
            g = math.log(1 + YEARLY_GROWTH) * span / (365.25 * 86400)
            created = datetime(2023, 1, 2, 8) + timedelta(seconds=span * math.log(1 + u * (math.exp(g) - 1)) / g)
        created = created.replace(microsecond=0)
        city = b["city"] if R.random() > 0.03 else R.choice(list(CITY_PLATE_CODE))
        if is_fleet:
            while True:
                company = f"{FAKE.last_name()} {R.choice(COMPANY_SECTORS)} {R.choice(COMPANY_SUFFIXES)}"
                if company not in used_companies:
                    used_companies.add(company)
                    break
            slug = ascii_slug(company.split(" A.Ş.")[0].split(" Ltd.")[0].split(" San.")[0].split(" Tic.")[0])
            local, domain = R.choice(("filo", "muhasebe", "info")), f"{slug.replace('.', '')}.example.com"
            email, n = f"{local}@{domain}", 2
            while email in used_emails:
                email, n = f"{local}{n}@{domain}", n + 1
            n_tmp = f"{R.randint(0, 9999999):07d}"
            area = CITY_PHONE_AREA.get(city, "212")
            if city == "İstanbul":
                area = R.choice(("212", "216"))
            phone = f"+90 {area} {n_tmp[:3]} {n_tmp[3:5]} {n_tmp[5:]}"
            name, tax_no, opt_in = company, invalid_vkn(), R.random() < 0.6
        else:
            first, last = FAKE.first_name(), FAKE.last_name()
            base = f"{ascii_slug(first)}.{ascii_slug(last)}"
            dom = R.choice(EMAIL_DOMAINS)
            email, n = f"{base}@{dom}", 2
            while email in used_emails:
                email, n = f"{base}{n}@{dom}", n + 1
            name, phone, tax_no, opt_in = f"{first} {last}", mobile_phone(), None, R.random() < 0.42
        used_emails.add(email)
        customers.append(dict(id=i + 1, fleet=is_fleet, name=name, phone=phone, email=email, city=city,
                              created=created, tax_no=tax_no, opt_in=opt_in, branch=b, vehicles=[]))
    ctx.customers = customers

    # Vehicles: individuals 1-3, fleets share the rest with a long tail (a few large fleets).
    individual_counts = {c["id"]: R.choices((1, 2, 3), (85, 13, 2))[0] for c in customers if not c["fleet"]}
    fleets = [c for c in customers if c["fleet"]]
    extra = N_VEHICLES - sum(individual_counts.values()) - len(fleets)
    weights = [R.paretovariate(1.15) for _ in fleets]
    total_w = sum(weights)
    alloc = [int(extra * w / total_w) for w in weights]
    order = sorted(range(len(fleets)), key=lambda k: -weights[k])
    for k in order[: extra - sum(alloc)]:
        alloc[k] += 1
    counts = dict(individual_counts)
    for c, a in zip(fleets, alloc):
        counts[c["id"]] = 1 + a
    ctx.overdue_customers = {fleets[k]["id"] for k in (order[1], order[3], order[6])}

    ind_cum = cumulative(m[2] for m in VEHICLE_MODELS)
    fleet_cum = cumulative(m[3] for m in VEHICLE_MODELS)
    vehicles = []
    for c in customers:
        for j in range(counts[c["id"]]):
            if j == 0:
                created = c["created"] + timedelta(minutes=R.randint(2, 30))
            else:
                created = rand_time(c["created"], AS_OF - timedelta(days=25))
            while True:
                m = VEHICLE_MODELS[weighted_index(fleet_cum if c["fleet"] else ind_cum)]
                newest = min(m[6], created.year + (1 if created.month >= 10 else 0))
                if m[5] <= newest:
                    break
            age = int(R.expovariate(1 / (3.5 if c["fleet"] else 6.0)))
            year = max(m[5], newest - age)
            fuels = list(m[4])
            fuel = R.choices(fuels, [m[4][f] for f in fuels])[0]
            km_age = max(0, created.year - year)
            yearly_km = R.uniform(25_000, 50_000) if c["fleet"] else R.uniform(9_000, 20_000)
            reg_km = int(km_age * yearly_km * R.uniform(0.8, 1.2) + R.uniform(0, 3000))
            home_code = CITY_PLATE_CODE[c["city"]]
            code = home_code if R.random() < (0.7 if c["fleet"] else 0.85) else R.choice(OTHER_PLATE_CODES)
            v = dict(id=len(vehicles) + 1, customer=c, plate=plate(code, used_plates), brand=m[0], model=m[1],
                     year=year, fuel=fuel, reg_km=reg_km, created=created.replace(microsecond=0),
                     km_per_day=yearly_km / 365.0)
            vehicles.append(v)
            c["vehicles"].append(v)
    ctx.vehicles = vehicles

    # Per-branch pools for picking the vehicle of an appointment (fleet vehicles visit twice as often).
    ctx.pools = {b["idx"]: [] for b in ctx.branches}
    for v in vehicles:
        entry = (v["created"] + timedelta(days=21), v["id"])
        ctx.pools[v["customer"]["branch"]["idx"]].append(entry)
        if v["customer"]["fleet"]:
            ctx.pools[v["customer"]["branch"]["idx"]].append(entry)
    for pool in ctx.pools.values():
        pool.sort()
    ctx.pool_keys = {k: [e[0] for e in pool] for k, pool in ctx.pools.items()}

    rows = ctx.table("customers", ["id", "type", "full_name_or_company", "phone", "email", "city", "created_at",
                                   "tax_no", "marketing_opt_in"])
    for c in customers:
        rows.append((c["id"], "fleet" if c["fleet"] else "individual", c["name"], c["phone"], c["email"],
                     c["city"], c["created"], c["tax_no"], c["opt_in"]))
    rows = ctx.table("vehicles", ["id", "customer_id", "plate", "brand", "model", "model_year", "fuel",
                                  "mileage_km_at_registration", "created_at"])
    for v in vehicles:
        rows.append((v["id"], v["customer"]["id"], v["plate"], v["brand"], v["model"], v["year"], v["fuel"],
                     v["reg_km"], v["created"]))


def pick_vehicle(ctx: Ctx, branch: dict, d: date) -> dict | None:
    src = branch
    siblings = ctx.city_branches[branch["city"]]
    if len(siblings) > 1 and R.random() < 0.07:
        src = R.choice(siblings)
    keys = ctx.pool_keys[src["idx"]]
    n = bisect.bisect_right(keys, at(d, 0))
    if n == 0:
        return None
    return ctx.vehicles[ctx.pools[src["idx"]][R.randrange(n)][1] - 1]


# ======================================================================= appointments, work orders, items
def daily_factor(branch: dict, d: date) -> float:
    if d < branch["opened_on"] or d.weekday() == 6:
        return 0.0
    f = branch["weight"] * MONTH_VOLUME[d.month - 1] * (1 + YEARLY_GROWTH) ** ((d - PERIOD_START).days / 365.25)
    if d.weekday() == 5:
        f *= SATURDAY_FACTOR
    if branch["opened_on"] >= PERIOD_START:
        months_open = (d - branch["opened_on"]).days / 30.4
        f *= min(1.0, 0.4 + 0.1 * months_open)
    if branch["code"] == CANKAYA:
        f *= 1 - CANKAYA_VOLUME_DROP * progress(d, CANKAYA_DECLINE_FROM)
    return f


def build_operations(ctx: Ctx) -> None:
    appts = ctx.table("appointments", ["id", "customer_id", "vehicle_id", "branch_id", "requested_at",
                                       "scheduled_for", "channel", "status", "note"])
    wos = ctx.table("work_orders", ["id", "appointment_id", "branch_id", "vehicle_id", "advisor_employee_id",
                                    "opened_at", "closed_at", "odometer_km", "status"])
    ctx.items = ctx.table("work_order_items", ["id", "work_order_id", "item_type", "service_id", "part_id",
                                               "technician_employee_id", "quantity", "labor_hours",
                                               "unit_price_try", "discount_pct"])
    ctx.part_uses = []      # (moved_at, branch idx, part id, qty, item id)
    ctx.done_work_orders = []
    days = [PERIOD_START + timedelta(days=k) for k in range((PERIOD_END - PERIOD_START).days + 1 + FUTURE_DAYS)]
    total = sum(daily_factor(b, d) for b in ctx.branches for d in days if d <= PERIOD_END)
    scale = N_APPOINTMENTS / total
    scale_wo = N_WORK_ORDERS_WITHOUT_APPOINTMENT / total
    addon_svcs = [ctx.service_by_code[c] for c in ADD_ON_SERVICES]
    ctx.addon = (addon_svcs, cumulative(ADD_ON_SERVICES.values()))

    for d in days:
        for b in ctx.branches:
            f = daily_factor(b, d)
            if f == 0:
                continue
            for _ in range(poisson(f * scale)):
                make_appointment(ctx, b, d, appts, wos)
            if d <= PERIOD_END:
                for _ in range(poisson(f * scale_wo)):
                    v = pick_vehicle(ctx, b, d)
                    if v is not None:
                        opened = at(d, R.uniform(8.5, 17.5 if d.weekday() < 5 else 13.5))
                        if opened <= AS_OF:
                            make_work_order(ctx, b, v, None, opened, wos, primary=None)


def make_appointment(ctx: Ctx, b: dict, d: date, appts: list, wos: list) -> None:
    v = pick_vehicle(ctx, b, d)
    if v is None:
        return
    c = v["customer"]
    svcs, cum, _ = service_mix(ctx, b["city"], d)
    primary = svcs[weighted_index(cum)]
    last_slot = 17.0 if d.weekday() < 5 else 13.5
    scheduled = at(d, 8.5 + 0.5 * R.randint(0, int((last_slot - 8.5) * 2)))
    years = (d - PERIOD_START).days / 365.25
    if c["fleet"]:
        channel = R.choices(("fleet_portal", "phone", "walk_in"), (60, 30, 10))[0]
    else:
        web = 0.30 + 0.05 * years
        channel = R.choices(("web", "phone", "walk_in"), (web, 0.92 - web - 0.10, 0.10))[0]
    if channel == "walk_in":
        scheduled = at(d, R.uniform(8.5, last_slot))
        requested = scheduled
        lead = 0.0
    else:
        mean_lead = 2.5
        if b["code"] == CANKAYA:
            mean_lead += (CANKAYA_LEAD_DAYS_AT_END - 2.5) * progress(d, CANKAYA_DECLINE_FROM) + 0.5
        lead = min(20.0, R.expovariate(1 / mean_lead))
        requested = scheduled - timedelta(days=lead)
        requested = at(requested.date(), R.uniform(8.0, 22.0)) if lead >= 1 else requested - timedelta(hours=R.uniform(1, 6))
        if requested > scheduled:
            requested = scheduled - timedelta(hours=1)
    if requested > AS_OF:
        return
    if scheduled > AS_OF:
        status = "confirmed" if R.random() < 0.65 else "pending"
    elif channel == "walk_in":
        status = "completed"
    else:
        r = R.random()
        no_show = 0.08 + min(0.10, lead * 0.006)
        status = "cancelled" if r < 0.17 else ("no_show" if r < 0.17 + no_show else "completed")
    note = None
    if R.random() < 0.25:
        note = R.choice(FLEET_NOTES) if c["fleet"] and R.random() < 0.4 else R.choice(APPOINTMENT_NOTES[primary["category"]])
    appt_id = len(appts) + 1
    appts.append((appt_id, c["id"], v["id"], b["id"], requested, scheduled, channel, status, note))
    ctx.appt_meta.append((c["id"], channel, requested))
    if status == "completed":
        opened = scheduled + timedelta(minutes=R.randint(-15, 40))
        opened = max(opened, requested)
        if opened > AS_OF:
            opened = scheduled
        make_work_order(ctx, b, v, appt_id, opened, wos, primary=primary)


def make_work_order(ctx: Ctx, b: dict, v: dict, appt_id: int | None, opened: datetime, wos: list,
                    primary: dict | None) -> None:
    d = opened.date()
    staff = active_staff(ctx, b, d)
    advisors = staff["service_advisor"] or staff["manager"]
    advisor = R.choice(advisors)
    svcs, cum, boost = service_mix(ctx, b["city"], d)
    if primary is None:
        primary = svcs[weighted_index(cum)]
    chosen = [primary]
    addon_svcs, addon_cum = ctx.addon
    for p in ADD_ON_PROBABILITIES:
        if R.random() >= p:
            break
        extra = addon_svcs[weighted_index(addon_cum)]
        if extra not in chosen and extra in svcs:
            chosen.append(extra)
    c = v["customer"]
    odometer = int(v["reg_km"] + v["km_per_day"] * max(0, (opened - v["created"]).days))
    wo_id = len(wos) + 1

    if R.random() < 0.012:  # cancelled at the counter: no lines, no invoice
        closed = opened + timedelta(minutes=R.randint(20, 90))
        wos.append((wo_id, appt_id, b["id"], v["id"], advisor["id"], opened, closed, odometer, "cancelled"))
        return

    year = d.year
    lines = []   # (cents, ...) for the invoice
    labor_hours_total = 0.0
    slow = 1.0
    if b["code"] == CANKAYA:
        slow += CANKAYA_DURATION_EXTRA * progress(d, CANKAYA_DECLINE_FROM)
    techs = staff["technician"]
    has_parts = False
    moved = opened + timedelta(minutes=R.randint(30, 120))
    for s in chosen:
        wanted = SPECIALTY_FOR_CATEGORY.get(s["category"], "general")
        specialists = [t for t in techs if t["specialty"] == wanted]
        tech = R.choice(specialists) if specialists and R.random() < 0.75 else R.choice(techs)
        hours = round(s["hours"] * R.uniform(0.85, 1.25) * (1 + 0.25 * (slow - 1)), 2)
        labor_hours_total += hours
        disc = 0
        if s["category"] in boost:
            disc = boost[s["category"]]["pct"]
        elif c["fleet"]:
            disc = FLEET_DISCOUNT_PCT
        elif R.random() < 0.03:
            disc = 10
        unit = s["price"][year]
        item_id = len(ctx.items) + 1
        ctx.items.append((item_id, wo_id, "labor", s["id"], None, tech["id"], "1", f"{hours:.2f}",
                          money(unit), f"{disc:.2f}"))
        lines.append(unit * (100 - disc) // 100)
        for kind, prob, (qmin, qmax) in s["parts"]:
            if R.random() >= prob:
                continue
            if kind == "oil":
                picks = [("oil_4l", 1), ("oil_1l", 1)] if R.random() < 0.6 else [("oil_1l", R.choice((4, 5)))]
            elif kind == "tyre":
                m = d.month
                season = "tyre_winter" if m in (10, 11, 12, 1, 2) else "tyre_summer"
                picks = [("tyre_allseason" if R.random() < 0.12 else season, R.randint(qmin, qmax))]
            else:
                picks = [(kind, R.randint(qmin, qmax))]
            for pk, qty in picks:
                part = pick_part(ctx, pk)
                unit = int(round(part["price_c"] * price_index(year) / price_index(2026) / 100)) * 100
                pdisc = FLEET_DISCOUNT_PCT if c["fleet"] else 0
                item_id = len(ctx.items) + 1
                ctx.items.append((item_id, wo_id, "part", None, part["id"], None, str(qty), None,
                                  money(unit), f"{pdisc:.2f}"))
                lines.append(qty * unit * (100 - pdisc) // 100)
                ctx.part_uses.append((min(moved, AS_OF), b["idx"], part["id"], qty, item_id))
                has_parts = True

    duration = (labor_hours_total * R.uniform(1.2, 2.2) + R.uniform(0.2, 1.0)) * slow
    if primary["category"] in ("bodywork", "engine") and primary["hours"] >= 3 and R.random() < 0.4:
        duration += R.uniform(4, 20)       # waiting for parts / paint drying
    closed = add_work_hours(opened, duration)
    if closed > AS_OF:
        if has_parts and R.random() < 0.3:
            status = "waiting_parts"
        elif AS_OF - opened < timedelta(hours=1):
            status = "open"
        else:
            status = "in_progress"
        closed = None
    else:
        status = "done"
    wos.append((wo_id, appt_id, b["id"], v["id"], advisor["id"], opened, closed, odometer, status))
    if status == "done":
        ctx.done_work_orders.append((wo_id, b, c, closed, sum(lines), duration / slow, slow))


# ======================================================================= appointment services
APPT_SERVICES_SEED = SEED + 4       # ACH-4: its own stream, so no other table moves when this one changes
APPT_SERVICE_COUNT_WEIGHTS = (60, 30, 10)     # 1, 2 or 3 requested services


def build_appointment_services(ctx: Ctx) -> None:
    """Services of every seeded appointment, drawn from a private random stream (never touches R).

    - appointment with a work order that has labor lines: exactly those services;
    - every other appointment (pending, confirmed, cancelled, no_show, and the rare work order cancelled
      at the counter, which has no lines): 1-3 services drawn from the seasonal / campaign mix of its
      branch city on its scheduled date, like a customer booking for that day;
    - list_price_try = the service_prices row valid on the scheduled date (same rule as a web booking).
    """
    rng = random.Random(APPT_SERVICES_SEED)
    rows = ctx.table("appointment_services", ["appointment_id", "service_id", "list_price_try"])
    appts = ctx.tables["appointments"][1]
    wo_appt = {w[0]: w[1] for w in ctx.tables["work_orders"][1] if w[1] is not None}
    labor: dict[int, list[int]] = defaultdict(list)
    for it in ctx.tables["work_order_items"][1]:
        if it[2] == "labor" and it[1] in wo_appt and it[3] not in labor[wo_appt[it[1]]]:
            labor[wo_appt[it[1]]].append(it[3])
    prices: dict[int, list[tuple]] = defaultdict(list)
    for service_id, valid_from, valid_to, price in ctx.tables["service_prices"][1]:
        prices[service_id].append((valid_from, valid_to, price))
    city_of = {b["id"]: b["city"] for b in ctx.branches}
    addon_svcs, addon_cum = ctx.addon

    def list_price(service_id: int, d: date) -> str:
        for valid_from, valid_to, price in prices[service_id]:
            if valid_from <= d and (valid_to is None or d <= valid_to):
                return price
        raise AssertionError(f"no list price for service {service_id} on {d}")

    def draw(cum: list[float]) -> int:
        return bisect.bisect_right(cum, rng.random() * cum[-1])

    for appt in appts:
        appt_id, branch_id, d = appt[0], appt[3], appt[5].date()
        service_ids = labor.get(appt_id)
        if not service_ids:
            svcs, cum, _ = service_mix(ctx, city_of[branch_id], d)
            n = rng.choices((1, 2, 3), APPT_SERVICE_COUNT_WEIGHTS)[0]
            chosen = [svcs[draw(cum)]]
            for _ in range(n - 1):
                extra = addon_svcs[draw(addon_cum)]
                if extra not in chosen and extra in svcs:
                    chosen.append(extra)
            service_ids = [s["id"] for s in chosen]
        for service_id in service_ids:
            rows.append((appt_id, service_id, list_price(service_id, d)))


# ======================================================================= invoices & payments
def build_billing(ctx: Ctx) -> None:
    invoices = ctx.table("invoices", ["id", "work_order_id", "customer_id", "branch_id", "issued_at", "due_on",
                                      "subtotal_try", "vat_try", "total_try", "status"])
    payments = ctx.table("payments", ["id", "invoice_id", "paid_at", "amount_try", "method"])
    today = AS_OF.date()

    def add_invoice(wo_id, b, c, issued, subtotal, status_override=None) -> int:
        vat = subtotal * vat_pct(issued.date()) // 100
        total = subtotal + vat
        inv_id = len(invoices) + 1
        paid = 0
        if status_override == "void":
            invoices.append((inv_id, wo_id, c["id"], b["id"], issued, issued.date(), money(subtotal), money(vat),
                             money(total), "void"))
            return inv_id
        if c["fleet"]:
            due = issued.date() + timedelta(days=30)
            if c["id"] in ctx.overdue_customers and issued.date() >= OVERDUE_FROM:
                if R.random() < 0.25:
                    part = total // 2
                    payments.append((len(payments) + 1, inv_id, rand_time(issued + timedelta(days=5), issued + timedelta(days=25)),
                                     money(part), "bank_transfer"))
                    paid = part
            else:
                pay_at = issued + timedelta(days=R.randint(5, 40), hours=R.randint(0, 6))
                if pay_at.date() >= due and due < today:
                    pay_at = rand_time(issued + timedelta(days=3), at(due, 17))
                if pay_at <= AS_OF:
                    payments.append((len(payments) + 1, inv_id, pay_at, money(total), "bank_transfer"))
                    paid = total
                elif R.random() < 0.25 and issued + timedelta(days=3) < AS_OF:
                    part = total // 2
                    payments.append((len(payments) + 1, inv_id, rand_time(issued + timedelta(days=3), AS_OF),
                                     money(part), "bank_transfer"))
                    paid = part
        else:
            method = R.choices(("card", "cash", "installment"), (60, 22, 18))[0]
            if method == "installment" and total >= 300000:
                due = issued.date() + timedelta(days=60)
                share = total // 3
                for k, amount in enumerate((share, share, total - 2 * share)):
                    pay_at = issued + timedelta(days=30 * k, minutes=R.randint(1, 20))
                    if pay_at <= AS_OF:
                        payments.append((len(payments) + 1, inv_id, pay_at, money(amount), "installment"))
                        paid += amount
            else:
                method = "card" if method == "installment" else method
                due = issued.date()
                payments.append((len(payments) + 1, inv_id, issued + timedelta(minutes=R.randint(1, 20)),
                                 money(total), method))
                paid = total
        if paid >= total:
            status = "paid"
        elif due < today:
            status = "overdue"
        elif paid > 0:
            status = "partially_paid"
        else:
            status = "unpaid"
        invoices.append((inv_id, wo_id, c["id"], b["id"], issued, due, money(subtotal), money(vat),
                         money(total), status))
        return inv_id

    for wo_id, b, c, closed, subtotal, _, _ in ctx.done_work_orders:
        issued = closed + timedelta(minutes=R.randint(1, 15))
        if issued > AS_OF:
            issued = closed
        if R.random() < 0.002 and issued + timedelta(days=3) < AS_OF:   # wrong invoice, voided and re-issued
            add_invoice(wo_id, b, c, issued, subtotal, "void")
            issued = issued + timedelta(days=R.randint(1, 3), hours=R.randint(0, 3))
        add_invoice(wo_id, b, c, issued, subtotal)


# ======================================================================= reviews
def build_reviews(ctx: Ctx) -> None:
    rows = ctx.table("reviews", ["id", "work_order_id", "customer_id", "branch_id", "created_at", "rating",
                                 "comment_tr"])
    rate = TARGET_REVIEWS / len(ctx.done_work_orders)
    branch_bias = {b["idx"]: R.uniform(-0.12, 0.12) for b in ctx.branches}
    for wo_id, b, c, closed, _, duration, slow in ctx.done_work_orders:
        if R.random() >= rate:
            continue
        created = closed + timedelta(hours=R.uniform(2, 24 * 7))
        if created > AS_OF:
            continue
        mu = 4.35 + branch_bias[b["idx"]]
        if b["code"] == CANKAYA:
            mu = 4.25 - CANKAYA_RATING_DROP * progress(closed.date(), CANKAYA_DECLINE_FROM)
        if duration > 8:
            mu -= 0.3
        rating = max(1, min(5, round(R.gauss(mu, 0.85))))
        comment = None
        if R.random() < 0.65:
            if b["code"] == CANKAYA and rating <= 3 and slow > 1.3 and R.random() < 0.6:
                comment = R.choice(WAIT_COMPLAINTS)
            else:
                comment = R.choice(REVIEW_COMMENTS[rating])
        rows.append((len(rows) + 1, wo_id, c["id"], b["id"], created.replace(microsecond=0), rating, comment))


# ======================================================================= web logins
def build_app_users(ctx: Ctx, password: str) -> None:
    salt_rng = random.Random(SEED + 1)
    alphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    salt = "$2b$12$" + "".join(salt_rng.choice(alphabet) for _ in range(21)) + salt_rng.choice(".Oeu")
    pw_hash = bcrypt.hashpw(password.encode(), salt.encode()).decode()

    first_online, visits = {}, defaultdict(int)
    for cust_id, channel, requested in ctx.appt_meta:
        visits[cust_id] += 1
        if channel in ("web", "fleet_portal") and cust_id not in first_online:
            first_online[cust_id] = requested

    demo_customers = set()
    for kind, code in DEMO_CUSTOMERS:     # busiest online customer of that type at that branch
        pool = [c for c in ctx.customers
                if c["id"] in first_online and c["branch"]["code"] == code and c["fleet"] == (kind == "fleet")
                and (2 <= len(c["vehicles"]) <= 3 if kind == "individual" else 4 <= len(c["vehicles"]) <= 10)]
        demo_customers.add(max(pool, key=lambda c: (visits[c["id"]], -c["id"]))["id"])
    demo_admins = {b["manager_id"] for b in ctx.branches if b["code"] in DEMO_BRANCH_ADMINS}
    ctx.demo_logins = []

    rows = ctx.table("app_users", ["id", "customer_id", "employee_id", "email", "password_hash", "role",
                                   "created_at"])
    for e in ctx.employees:
        if e["role"] in ("manager", "service_advisor") and e["left_on"] is None:
            created = max(at(e["hired_on"], 9), datetime(2023, 1, 2, 9))
            demo = e["id"] in demo_admins
            rows.append((len(rows) + 1, None, e["id"], e["email"], pw_hash if demo else None, "admin", created))
            if demo:
                ctx.demo_logins.append(f"branch admin ({e['branch']['code']}): {e['email']}")
    for c in ctx.customers:
        first = first_online.get(c["id"])
        if first is None:
            continue
        created = max(c["created"], first - timedelta(minutes=R.randint(3, 600)))
        if created > first:
            created = first
        demo = c["id"] in demo_customers
        rows.append((len(rows) + 1, c["id"], None, c["email"], pw_hash if demo else None, "customer", created))
        if demo:
            kind = "fleet" if c["fleet"] else "individual"
            ctx.demo_logins.append(f"customer ({kind}, {c['branch']['code']}): {c['email']}")
    rows.append((len(rows) + 1, None, None, HQ_ADMIN_EMAIL, pw_hash, "admin", datetime(2023, 1, 2, 9)))
    ctx.demo_logins.append(f"HQ admin (all branches): {HQ_ADMIN_EMAIL}")


# ======================================================================= inventory & purchasing
def build_inventory(ctx: Ctx) -> None:
    """Reorder points from demand, then a day-by-day stock simulation that produces purchase orders,
    receipts, transfers, adjustments and the final stock levels (= sum of movements)."""
    last_year = AS_OF - timedelta(days=365)
    demand = defaultdict(int)          # (branch idx, part id) -> qty used in the last 12 months
    max_use = defaultdict(int)
    for moved, bidx, pid, qty, _ in ctx.part_uses:
        if moved >= last_year:
            demand[(bidx, pid)] += qty
        max_use[pid] = max(max_use[pid], qty)
    open_days = {b["idx"]: min(365, (AS_OF.date() - b["opened_on"]).days) for b in ctx.branches}
    for p in ctx.parts:
        lead = p["supplier"]["lead"]
        per_branch_day = sum(demand[(b["idx"], p["id"])] / open_days[b["idx"]] for b in ctx.branches) / len(ctx.branches)
        p["reorder_point"] = max(1, math.ceil(per_branch_day * (lead + 7)))
    rows = ctx.table("parts", ["id", "sku", "name", "category", "brand", "unit_cost_try", "unit_price_try",
                               "reorder_point"])
    for p in ctx.parts:
        rows.append((p["id"], p["sku"], p["name"], p["category"], p["brand"], money(p["cost_c"]),
                     money(p["price_c"]), p["reorder_point"]))

    part_by_id = {p["id"]: p for p in ctx.parts}
    trigger, up_to = {}, {}
    for b in ctx.branches:
        for p in ctx.parts:
            key = (b["idx"], p["id"])
            daily = demand[key] / open_days[b["idx"]]
            lead = p["supplier"]["lead"]
            trigger[key] = p["reorder_point"] + math.ceil(daily * (lead + 4)) + max_use[p["id"]]
            up_to[key] = trigger[key] + max(2, math.ceil(daily * 21))

    # Pairs whose primary supplier stops delivering in autumn 2026 (the "below reorder point" pattern).
    candidates = sorted(k for k, q in demand.items() if q >= 25 and ctx.branches[k[0]]["code"] != "KON-SEL")
    blocked = set(R.sample(candidates, BELOW_REORDER_PAIRS))
    blocked_done = set()

    pos = ctx.table("purchase_orders", ["id", "supplier_id", "branch_id", "ordered_at", "received_at", "status",
                                        "total_cost_try"])
    po_lines = ctx.table("purchase_order_lines", ["purchase_order_id", "part_id", "qty", "unit_cost_try"])
    moves = ctx.table("stock_movements", ["id", "branch_id", "part_id", "moved_at", "qty", "reason",
                                          "work_order_item_id", "purchase_order_id"])
    levels = ctx.table("stock_levels", ["branch_id", "part_id", "on_hand", "updated_at"])

    on_hand, on_order, updated = {}, defaultdict(int), {}

    def move(bidx, pid, t, qty, reason, item_id=None, po_id=None):
        moves.append((len(moves) + 1, bidx + 1, pid, t, qty, reason, item_id, po_id))
        on_hand[(bidx, pid)] += qty
        updated[(bidx, pid)] = t

    for b in ctx.branches:
        opening = at(max(b["opened_on"], PERIOD_START), 7)
        for p in ctx.parts:
            key = (b["idx"], p["id"])
            on_hand[key] = 0
            move(b["idx"], p["id"], opening, up_to[key], "adjustment")

    po_meta = {}                 # po id -> dict(lines={pid: qty}, branch, received, status, ordered)
    batches = {}                 # (branch idx, supplier id, day) -> po id
    receipts: list[tuple[datetime, int]] = []

    def unit_cost(pid, t):
        p = part_by_id[pid]
        return int(round(p["cost_c"] * price_index(t.year) / price_index(2026) / 100)) * 100

    def new_po(bidx, supplier, ordered, received, status, queue=True):
        po_id = len(po_meta) + 1
        po_meta[po_id] = dict(lines={}, branch=bidx, supplier=supplier, ordered=ordered, received=received,
                              status=status)
        if status == "received" and queue:
            heapq.heappush(receipts, (received, po_id))
        return po_id

    def order(bidx, pid, t):
        key = (bidx, pid)
        if key in blocked and t >= STOCK_BLOCK_FROM:
            if key not in blocked_done:      # one order, cancelled by the supplier
                blocked_done.add(key)
                po_id = new_po(bidx, part_by_id[pid]["supplier"], at(t.date(), 17.5), None, "cancelled")
                po_meta[po_id]["lines"][pid] = up_to[key] - on_hand[key]
            return
        qty = up_to[key] - on_hand[key] - on_order[key]
        if qty <= 0:
            return
        supplier = part_by_id[pid]["supplier"]
        day = t.date() if t.hour < 17 else t.date() + timedelta(days=1)
        bkey = (bidx, supplier["id"], day)
        po_id = batches.get(bkey)
        if po_id is None:
            ordered = at(day, 17.5)
            received = at(day + timedelta(days=max(1, supplier["lead"] + R.choice((-1, 0, 0, 1)))), R.uniform(9, 15))
            po_id = new_po(bidx, supplier, ordered, received if received <= AS_OF else None,
                           "received" if received <= AS_OF else "ordered")
            batches[bkey] = po_id
        lines = po_meta[po_id]["lines"]
        lines[pid] = lines.get(pid, 0) + qty
        on_order[key] += qty

    def receive_until(t):
        while receipts and receipts[0][0] <= t:
            received, po_id = heapq.heappop(receipts)
            meta = po_meta[po_id]
            for pid, qty in meta["lines"].items():
                move(meta["branch"], pid, received, qty, "purchase", po_id=po_id)
                on_order[(meta["branch"], pid)] -= qty

    ctx.part_uses.sort()
    for moved, bidx, pid, qty, item_id in ctx.part_uses:
        receive_until(moved)
        key = (bidx, pid)
        if on_hand[key] < qty:
            need = qty - on_hand[key]
            src = max((b for b in ctx.branches if b["idx"] != bidx and at(b["opened_on"], 7) <= moved),
                      key=lambda b: (on_hand[(b["idx"], pid)], -b["idx"]))
            t = moved - timedelta(minutes=30)
            if on_hand[(src["idx"], pid)] >= need + part_by_id[pid]["reorder_point"]:
                move(src["idx"], pid, t, -need, "transfer")
                move(bidx, pid, t, need, "transfer")
                if on_hand[(src["idx"], pid)] + on_order[(src["idx"], pid)] <= trigger[(src["idx"], pid)]:
                    order(src["idx"], pid, t)
            else:   # express delivery from the primary supplier the same morning
                po_id = new_po(bidx, part_by_id[pid]["supplier"], moved - timedelta(hours=3),
                               moved - timedelta(minutes=20), "received", queue=False)
                po_meta[po_id]["lines"][pid] = need
                move(bidx, pid, moved - timedelta(minutes=20), need, "purchase", po_id=po_id)
        move(bidx, pid, moved, -qty, "use", item_id=item_id)
        if on_hand[key] > 2 and R.random() < 0.004:     # stock count finds a missing unit
            move(bidx, pid, moved + timedelta(hours=R.randint(1, 5)), -1, "adjustment")
        if on_hand[key] + on_order[key] <= trigger[key]:
            order(bidx, pid, moved)
    receive_until(AS_OF)

    for key in sorted(blocked):          # stock count before the report confirms the shortfall
        rp = part_by_id[key[1]]["reorder_point"]
        if on_hand[key] >= rp:
            target = max(0, rp - R.randint(1, 3))
            move(key[0], key[1], at(date(2026, 11, R.randint(10, 14)), 18), target - on_hand[key], "adjustment")

    for po_id, meta in po_meta.items():
        total = 0
        for pid, qty in sorted(meta["lines"].items()):
            uc = unit_cost(pid, meta["ordered"])
            po_lines.append((po_id, pid, qty, money(uc)))
            total += qty * uc
        pos.append((po_id, meta["supplier"]["id"], meta["branch"] + 1, meta["ordered"], meta["received"],
                    meta["status"], money(total)))
    for (bidx, pid), qty in sorted(on_hand.items()):
        assert qty >= 0, (bidx, pid, qty)
        levels.append((bidx + 1, pid, qty, updated[(bidx, pid)]))
    ctx.below_reorder = sum(1 for (bidx, pid), q in on_hand.items() if q < part_by_id[pid]["reorder_point"])
    ctx.blocked = blocked


# ======================================================================= output
def copy_value(v) -> str:
    if v is None:
        return r"\N"
    if v is True:
        return "t"
    if v is False:
        return "f"
    if isinstance(v, datetime):
        return v.isoformat(sep=" ") + TZ_SUFFIX
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, str):
        return v.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")
    return str(v)


LOAD_ORDER = ["branches", "employees", "customers", "app_users", "vehicles", "service_catalog", "service_prices",
              "parts", "suppliers", "part_suppliers", "campaigns", "appointments", "work_orders",
              "work_order_items", "invoices", "payments", "purchase_orders", "purchase_order_lines",
              "stock_levels", "stock_movements", "reviews", "appointment_services"]


def write_output(ctx: Ctx) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.copy.gz"):
        old.unlink()
    manifest = []
    for name in LOAD_ORDER:
        columns, rows = ctx.tables[name]
        path = OUT_DIR / f"{name}.copy.gz"
        with gzip.GzipFile(path, "wb", compresslevel=6, mtime=0) as raw:
            buf = []
            for row in rows:
                buf.append("\t".join(copy_value(v) for v in row))
                if len(buf) >= 20000:
                    raw.write(("\n".join(buf) + "\n").encode())
                    buf = []
            if buf:
                raw.write(("\n".join(buf) + "\n").encode())
        manifest.append(f"{name}\t{','.join(columns)}\t{path.name}\t{len(rows)}")
    (OUT_DIR / "manifest.tsv").write_text("\n".join(manifest) + "\n")


def demo_password() -> str:
    pw = os.environ.get("SEED_DEMO_PASSWORD")
    env_file = REPO_DIR / ".env"
    if not pw and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("SEED_DEMO_PASSWORD="):
                pw = line.split("=", 1)[1].strip().strip("'\"")
    if not pw:
        sys.exit("SEED_DEMO_PASSWORD is not set (environment or .env)")
    return pw


def main() -> None:
    started = time.monotonic()
    password = demo_password()
    ctx = Ctx()
    ctx.appt_meta = []
    build_branches_and_employees(ctx)
    build_catalog(ctx)
    build_parts_and_suppliers(ctx)
    build_customers_and_vehicles(ctx)
    build_operations(ctx)
    build_billing(ctx)
    build_reviews(ctx)
    build_app_users(ctx, password)
    build_inventory(ctx)
    build_appointment_services(ctx)
    write_output(ctx)
    for name in LOAD_ORDER:
        print(f"{name:22s} {len(ctx.tables[name][1]):>9,d}")
    print(f"stock pairs below reorder point: {ctx.below_reorder} (engineered: {len(ctx.blocked)})")
    print("demo logins (password = SEED_DEMO_PASSWORD):")
    for line in ctx.demo_logins:
        print(f"  {line}")
    print(f"generated in {time.monotonic() - started:.1f} s -> {OUT_DIR}")


if __name__ == "__main__":
    main()
