#!/usr/bin/env python3
import json, glob, os, collections, sys
errors=[]; total=0; global_sections={}
for path in sorted(glob.glob('data/municipio-*.json')):
    mu=os.path.basename(path)[10:12]
    with open(path,encoding='utf-8') as f: data=json.load(f)
    if data.get('m') != mu: errors.append(f'{path}: municipio interno {data.get("m")} diverso da {mu}')
    local=set()
    for section in data.get('sezioni',[]):
        number=str(section.get('s','')).strip()
        total += 1
        if not number: errors.append(f'{path}: sezione senza numero'); continue
        if number in local: errors.append(f'{path}: sezione duplicata {number}')
        local.add(number)
        if number in global_sections: errors.append(f'sezione {number} presente in {mu} e {global_sections[number]}')
        global_sections[number]=mu
        if not section.get('addr'): errors.append(f'{mu}/{number}: indirizzo mancante')
        if not isinstance(section.get('v'),list): errors.append(f'{mu}/{number}: vie mancanti o non valide')
with open('data/indice-sezioni.json',encoding='utf-8') as f: index=json.load(f)
if len(index)!=total: errors.append(f'indice: {len(index)} record, dataset: {total}')
for number,mu in global_sections.items():
    if str(index.get(number,'')).zfill(2) != mu: errors.append(f'indice errato per sezione {number}: {index.get(number)} invece di {mu}')
print(f'Municipi: {len(glob.glob("data/municipio-*.json"))}; sezioni: {total}; indice: {len(index)}')
if errors:
    print('\n'.join(errors[:100])); print(f'Errori totali: {len(errors)}'); sys.exit(1)
print('VALIDAZIONE OK')
