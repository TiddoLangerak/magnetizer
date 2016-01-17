export function memoize(factory, keyFunc = x => x, cache = new Map()) {
	const func = (...params) => {
		const key = keyFunc(...params);
		if (!cache.has(key)) {
			cache.set(key, factory(...params));
		}
		return cache.get(key);
	};
	func.forget = (...params) => {
		cache.delete(keyFunc(...params));
	}
	return func;
}

export function weakMemoize(factory, keyFunc = x => x) {
	return memoize(factory, keyFunc, new WeakMap());
}

export function promisify(f) {
	return new Promise((resolve, reject) => {
		f((err, res) => {
			if (err) {
				reject(err);
			} else {
				resolve(res);
			}
		});
	});
}
