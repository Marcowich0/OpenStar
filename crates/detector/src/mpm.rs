//! The McLeod Pitch Method (McLeod & Wyvill, "A smarter way to find pitch",
//! 2005), after the `pitchy` JavaScript implementation it replaces.
//!
//! 1. The normalised square difference function (NSDF) of the window,
//!    `nsdf(τ) = 2·r(τ) / m(τ)`, where `r` is the autocorrelation (by FFT) and
//!    `m(τ) = Σ (x[j]² + x[j+τ]²)` over the overlapping part.
//! 2. Key maxima: the highest NSDF point between each positive-going zero
//!    crossing and the next negative-going one, after the first negative-going
//!    crossing. Only lags up to half the window are searched: beyond that the
//!    NSDF rests on less than half the window, and on noise it reaches 1 by
//!    chance. Half of 2048 samples still reaches 43 Hz at 44.1 kHz, below C2.
//! 3. The first key maximum at least [`Mpm::CUTOFF`] times the highest one is
//!    the period; parabolic interpolation refines its lag and height.
//! 4. Frequency = sample rate / lag; clarity = the interpolated height, in 0..=1.

use crate::detector::{Detection, Detector};
use crate::fft::Fft;

/// The McLeod Pitch Method detector.
pub struct Mpm {
    fft: Option<Fft>,
    re: Vec<f64>,
    im: Vec<f64>,
    nsdf: Vec<f64>,
    key_maxima: Vec<usize>,
}

impl Default for Mpm {
    fn default() -> Self {
        Self::new()
    }
}

impl Mpm {
    /// A key maximum counts as the period once it reaches this fraction of the
    /// highest key maximum (`pitchy`'s and the paper's usual value).
    pub const CUTOFF: f64 = 0.9;

    /// Below this `m(τ)` the overlap holds no energy and the NSDF is taken as 0.
    const MIN_ENERGY: f64 = 1e-20;

    pub fn new() -> Self {
        Self {
            fft: None,
            re: Vec::new(),
            im: Vec::new(),
            nsdf: Vec::new(),
            key_maxima: Vec::new(),
        }
    }

    /// Fills `self.nsdf` for lags `0..=window.len() / 2`.
    fn compute_nsdf(&mut self, window: &[f32]) {
        let n = window.len();
        let fft_len = (2 * n).next_power_of_two();
        if self.fft.as_ref().is_none_or(|fft| fft.len() != fft_len) {
            self.fft = Some(Fft::new(fft_len));
            self.re = vec![0.0; fft_len];
            self.im = vec![0.0; fft_len];
            self.nsdf = vec![0.0; n / 2 + 1];
        }
        let Some(fft) = self.fft.as_ref() else {
            unreachable!("planned above")
        };

        // Autocorrelation: zero-pad to avoid wrap-around, |FFT|², FFT again.
        // The power spectrum is real and even, so a forward transform equals
        // the inverse up to the 1/len factor.
        for (dst, &x) in self.re.iter_mut().zip(window) {
            *dst = f64::from(x);
        }
        self.re[n..].fill(0.0);
        self.im.fill(0.0);
        fft.forward(&mut self.re, &mut self.im);
        for (re, im) in self.re.iter_mut().zip(self.im.iter_mut()) {
            *re = *re * *re + *im * *im;
            *im = 0.0;
        }
        fft.forward(&mut self.re, &mut self.im);
        let scale = 1.0 / fft_len as f64;

        let mut m: f64 = 2.0
            * window
                .iter()
                .map(|&x| f64::from(x) * f64::from(x))
                .sum::<f64>();
        for tau in 0..self.nsdf.len() {
            if tau > 0 {
                let a = f64::from(window[tau - 1]);
                let b = f64::from(window[n - tau]);
                m -= a * a + b * b;
            }
            let r = self.re[tau] * scale;
            self.nsdf[tau] = if m > Self::MIN_ENERGY {
                (2.0 * r / m).clamp(-1.0, 1.0)
            } else {
                0.0
            };
        }
    }

    /// Fills `self.key_maxima` with the lags of the NSDF's key maxima, for a
    /// window of `window_len` samples.
    fn pick_key_maxima(&mut self, window_len: usize) {
        let nsdf = &self.nsdf;
        let maxima = &mut self.key_maxima;
        maxima.clear();
        let n = nsdf.len();
        if n < 3 {
            return;
        }

        // Skip the lobe around lag 0, up to the first negative-going crossing.
        // A window that never goes negative early (silence, DC) has no period.
        let mut pos = 0;
        let first_lobe_limit = ((window_len - 1) / 3).min(n - 1);
        while pos < first_lobe_limit && nsdf[pos] > 0.0 {
            pos += 1;
        }
        if nsdf[pos] > 0.0 {
            return;
        }
        while pos < n - 1 && nsdf[pos] <= 0.0 {
            pos += 1;
        }
        pos = pos.max(1);

        let mut current: Option<usize> = None;
        while pos < n - 1 {
            if nsdf[pos] > nsdf[pos - 1] && nsdf[pos] >= nsdf[pos + 1] {
                current = match current {
                    Some(best) if nsdf[best] >= nsdf[pos] => Some(best),
                    _ => Some(pos),
                };
            }
            pos += 1;
            if pos < n - 1 && nsdf[pos] <= 0.0 {
                if let Some(best) = current.take() {
                    maxima.push(best);
                }
                while pos < n - 1 && nsdf[pos] <= 0.0 {
                    pos += 1;
                }
            }
        }
        if let Some(best) = current {
            maxima.push(best);
        }
    }
}

impl Detector for Mpm {
    fn detect(&mut self, window: &[f32], sample_rate: f64) -> Detection {
        const NONE: Detection = Detection {
            frequency: None,
            clarity: 0.0,
        };
        if window.len() < 6 {
            return NONE;
        }
        self.compute_nsdf(window);
        self.pick_key_maxima(window.len());

        let nsdf = &self.nsdf;
        let Some(highest) = self
            .key_maxima
            .iter()
            .map(|&lag| nsdf[lag])
            .reduce(f64::max)
        else {
            return NONE;
        };
        let cutoff = Self::CUTOFF * highest;
        let Some(&lag) = self.key_maxima.iter().find(|&&lag| nsdf[lag] >= cutoff) else {
            return NONE;
        };

        // Parabolic interpolation through the peak and its neighbours.
        let (a, b, c) = (nsdf[lag - 1], nsdf[lag], nsdf[lag + 1]);
        let curvature = a - 2.0 * b + c;
        let (offset, height) = if curvature < 0.0 {
            let offset = 0.5 * (a - c) / curvature;
            (offset, b - 0.25 * (a - c) * offset)
        } else {
            (0.0, b)
        };
        let period = lag as f64 + offset;
        Detection {
            frequency: Some(sample_rate / period),
            clarity: height.clamp(0.0, 1.0),
        }
    }
}
