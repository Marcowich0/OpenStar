//! A small radix-2 complex FFT, enough for MPM's autocorrelation. It is
//! planned once per window length so a detector never allocates per window.

use std::f64::consts::TAU;

pub(crate) struct Fft {
    len: usize,
    /// `e^(−2πik/len)` for `k < len / 2`.
    twiddles: Vec<(f64, f64)>,
    bit_reversed: Vec<usize>,
}

impl Fft {
    /// Plans an FFT of `len` points; `len` must be a power of two.
    pub(crate) fn new(len: usize) -> Self {
        assert!(len.is_power_of_two(), "FFT length must be a power of two");
        let bits = len.trailing_zeros();
        let twiddles = (0..len / 2)
            .map(|k| {
                let angle = -TAU * k as f64 / len as f64;
                (angle.cos(), angle.sin())
            })
            .collect();
        let bit_reversed = (0..len)
            .map(|i| {
                if bits == 0 {
                    0
                } else {
                    i.reverse_bits() >> (usize::BITS - bits)
                }
            })
            .collect();
        Self {
            len,
            twiddles,
            bit_reversed,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// In-place forward transform of `len` complex values (unnormalised).
    pub(crate) fn forward(&self, re: &mut [f64], im: &mut [f64]) {
        let n = self.len;
        for (i, &j) in self.bit_reversed.iter().enumerate() {
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= n {
            let half = size / 2;
            let step = n / size;
            for start in (0..n).step_by(size) {
                for k in 0..half {
                    let (wr, wi) = self.twiddles[k * step];
                    let a = start + k;
                    let b = a + half;
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            size *= 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_a_direct_dft() {
        let n = 16;
        let fft = Fft::new(n);
        let input: Vec<f64> = (0..n).map(|i| ((i * 7 % 5) as f64) - 2.0).collect();
        let mut re = input.clone();
        let mut im = vec![0.0; n];
        fft.forward(&mut re, &mut im);
        for k in 0..n {
            let (mut dr, mut di) = (0.0, 0.0);
            for (j, x) in input.iter().enumerate() {
                let angle = -TAU * (j * k) as f64 / n as f64;
                dr += x * angle.cos();
                di += x * angle.sin();
            }
            assert!(
                (re[k] - dr).abs() < 1e-9 && (im[k] - di).abs() < 1e-9,
                "bin {k}"
            );
        }
    }
}
