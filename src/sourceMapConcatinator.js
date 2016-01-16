export const modes = {
	FAST : 'fast',
	COMPAT : 'compat'
}

function countCharOccurrence(string, search) {
	//We could either split the string on the search charater or iterate over the string.
	//Splitting is in general faster for larger strings (>~1000chars) that are made up of `search` characters
	//for less than ~10%. For small strings or strings that mostly consist of the search string
	//iterating is faster. Since we expect mostly large strings here with a relatively small
	//percentage of searches (searching for semicolons in sourcemaps) we use the split method here
	//http://jsperf.com/char-count-performance
	return string.split(search).length - 1;
}

const concatinators = {
	[modes.FAST](file) {
		const sourceMap = {
			version : 3,
			file,
			sections : []
		};

		const offset = {
			line : 0,
			column : 0
		};

		const concatinator = {
			skipLines(nrOfLines) {
				offset.line += nrOfLines;
				offset.column = 0;
				return concatinator;
			},
			addSource(source, map = null) {
				if (map) {
					const section = {
						offset : Object.assign({}, offset),
						map
					};
					sourceMap.sections.push(section);
				}

				const newLines = countCharOccurrence(source, '\n');
				concatinator.skipLines(newLines);
				return concatinator;
			},
			getMap() {
				return sourceMap
			}
		}

		return concatinator;
	},
	[modes.COMPAT](file) {
		throw new Error('Not yet implemented');
	}

}

export default function createConcatinator(file, { mode : mode = modes.FAST } = {}) {
	if (!concatinators[mode]) {
		const modes = Object.keys(modes).map(mode => `mode.${mode}`).join(',');
		throw new Error(`Invalid mode specified, must be one of ${modes}`);
	}
	return concatinators[mode](file);
}
