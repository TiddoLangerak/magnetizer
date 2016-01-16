import vlq from 'vlq';

export const modes = {
	FAST : 'fast',
	COMPAT : 'compat'
}

function countCharOccurrence(string, search) {
	//We could either split the string on the search charater or iterate over the string.
	//Splitting is in general faster for larger strings (>~1000chars) that are made up of `search` characters
	//for less than ~10%. For small strings or strings that mostly consist of the search string
	//iterating is faster. Since we expect mostly large strings here with a relatively small
	//percentage of searches (searching for semicolons in sourcemaps, or newlines in sources) we use the split method here
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
				return sourceMap;
			}
		}

		return concatinator;
	},
	[modes.COMPAT](file) {
		const sourceMap = {
			version : 3,
			file,
			sources : [],
			sourcesContent : [],
			names : [],
			mappings : ''
		};

		let sourcesIdx = 0;
		let currentLine = 0;
		let currentColumn = 0;
		let nameIdx = 0;

		const concatinator = {
			skipLines(nrOfLines) {
				sourceMap.mappings += new Array(nrOfLines + 1).join(';');
				return concatinator;
			},
			addSource(source, map = null) {
				if (map) {
					let firstMapping = true;
					const mappedLines = map.mappings.split(';');
					const newLines = countCharOccurrence(source, '\n');
					const nrOfMappedLines = mappedLines.length - 1;
					let trailingLines = 0;
					if ( nrOfMappedLines > newLines) {
						console.warn(`Sourcemap for ${map.sources[0]} maps more lines then present in the file`);
						console.warn(`Cutting of excessive mappings`);
						mappedLines.splice(newLines - nrOfMappedLines);
					} else {
						trailingLines = newLines - nrOfMappedLines;
					}

					const adjustedMappings = mappedLines.map(line => {
						if (!line) {
							return '';
						}
						return line.split(',').map(mapping => {
							const vals = vlq.decode(mapping);
							//Most values are relative to the previous value. The first value of each new
							//source therefore must be adjusted for the previous sources
							if (firstMapping) {
								if (vals.length > 1) {
									//Relative index into the sources list.
									//We need to add an offset for the sources from earlier maps
									//and substract the current index we're at.
									vals[1] += sourceMap.sources.length;
									vals[1] -= sourcesIdx;
									if (vals[1] + sourcesIdx >= sourceMap.sources.length + map.sources.length) {
										throw new Error("out of bounds sources");
									}
								}

								if (vals.length > 2) {
									//Line in source, relative to previous line value
									vals[2] -= currentLine;
								}

								if (vals.length > 3) {
									//Column in source, relative to previous line value
									vals[3] -= currentColumn;
								}

								if (vals.length > 4) {
									//offset in de names array
									//Just like index in the sources list, this needs to be adjusted for the names
									//in the earlier maps, as well as for the current index we're at.
									vals[4] += sourceMap.names.length;
									vals[4] -= nameIdx;
								}

								firstMapping = false;
							}

							if (vals.length > 1) {
								sourcesIdx += vals[1];
							}
							if (vals.length > 2) {
								currentLine += vals[2];
							}
							if (vals.length > 3) {
								currentColumn += vals[3];
							}
							if (vals.length > 4) {
								nameIdx += vals[4];
							}
							return vlq.encode(vals);
						}).join(',');
					}).join(';');

					if (map.sources) {
						sourceMap.sources = [...sourceMap.sources, ...map.sources];
						sourceMap.sourcesContent = [...sourceMap.sourcesContent, ...map.sourcesContent];
					}
					if (map.names) {
						sourceMap.names = [...sourceMap.names, ...map.names];
					}

					sourceMap.mappings += adjustedMappings;

					if (trailingLines) {
						concatinator.skipLines(trailingLines);
					}

				} else {
					const newLines = countCharOccurrence(source, '\n');
					concatinator.skipLines(newLines);
				}
				return concatinator;
			},
			getMap() {
				return sourceMap;
			}
		}
		return concatinator;
	}

}

export default function createConcatinator(file, { mode : mode = modes.FAST } = {}) {
	console.log(`Creating source map using ${mode} mode`);
	if (!concatinators[mode]) {
		const modes = Object.keys(modes).map(mode => `mode.${mode}`).join(',');
		throw new Error(`Invalid mode specified, must be one of ${modes}`);
	}
	return concatinators[mode](file);
}
