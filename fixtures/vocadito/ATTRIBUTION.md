# Attribution

The audio excerpts (`vocadito_*.wav`) and their f0 references
(`vocadito_*_f0.csv`) in this directory are taken from:

- **Dataset:** vocadito: A dataset of solo vocals with f0, note, and lyric
  annotations
- **Authors:** Rachel Bittner, Katherine Pasalo, Juan José Bosch, Gabriel
  Meseguer-Brocal, David Rubinstein
- **Source:** Zenodo, <https://zenodo.org/records/5578807>,
  doi:[10.5281/zenodo.5578807](https://doi.org/10.5281/zenodo.5578807)
  (file `vocadito.zip`, MD5 `dea40fd18f14d899643c4ba221b33a46`)
- **Technical report:** <https://arxiv.org/abs/2110.05580>
- **Licence:** Creative Commons Attribution 4.0 International (CC BY 4.0),
  <https://creativecommons.org/licenses/by/4.0/>, as stated on the Zenodo
  record.

## Changes made

Each file here is a 3.0 s excerpt (132 352 samples, 517 f0 frames) of the
dataset's track of the same number, cut on the f0 annotation's 256-sample
grid. The audio is unchanged otherwise (16-bit mono PCM, 44.1 kHz). The f0
rows are the dataset's `Annotations/F0/vocadito_<n>_f0.csv` rows for the same
span, with the times rewritten to start at 0 s. No lyrics or note annotations
are included.

| File          | Start in the track (samples) | Start (s) |
| ------------- | ---------------------------- | --------- |
| `vocadito_2`  | 111 616                      | 2.531     |
| `vocadito_4`  | 184 576                      | 4.185     |
| `vocadito_6`  | 293 632                      | 6.658     |
| `vocadito_26` | 35 328                       | 0.801     |
| `vocadito_35` | 73 216                       | 1.660     |
