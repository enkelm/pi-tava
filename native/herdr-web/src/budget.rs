//! Byte accounting includes queue entries and the consumer's in-flight buffer.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
pub const MAX_QUEUE_BYTES: usize = 32 * 1024 * 1024;

pub struct Bytes {
    pub data: Vec<u8>,
    budget: Arc<AtomicUsize>,
}
impl Bytes {
    pub fn claim(data: Vec<u8>, budget: &Arc<AtomicUsize>) -> Option<Self> {
        budget
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(data.len())
                    .filter(|next| *next <= MAX_QUEUE_BYTES)
            })
            .ok()?;
        Some(Self {
            data,
            budget: budget.clone(),
        })
    }
}
impl Drop for Bytes {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.data.len(), Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credit_is_released_on_drop() {
        let budget = Arc::new(AtomicUsize::new(MAX_QUEUE_BYTES - 2));
        let first = Bytes::claim(vec![0; 2], &budget).unwrap();
        assert!(Bytes::claim(vec![0], &budget).is_none());
        drop(first);
        assert!(Bytes::claim(vec![0], &budget).is_some());
    }
}
