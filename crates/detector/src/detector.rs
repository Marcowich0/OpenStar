/// What a [`Detector`] reports for one window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Detection {
    /// The fundamental frequency in Hz, or `None` when the detector found none.
    pub frequency: Option<f64>,
    /// How clearly the window is a pitched tone, from 0 to 1. For MPM this is
    /// the normalised height of the chosen peak.
    pub clarity: f64,
}

/// A pitch detector: one window of samples and its sample rate in, a
/// [`Detection`] out.
///
/// A detector applies no gate: it reports every window, however quiet or
/// unclear. Loudness, the window length and the cadence are not its concern.
/// `&mut self` lets an implementation keep scratch buffers between windows.
pub trait Detector {
    fn detect(&mut self, window: &[f32], sample_rate: f64) -> Detection;
}
