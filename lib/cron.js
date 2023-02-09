var Cron = {
	parse : function ( cron ) {
		var parts = cron.split( ' ' );

		return {
			minute : parts[0],
			hour : parts[1],
			dayOfMonth : parts[2],
			month : parts[3],
			dayOfWeek : parts[4]
		};
	},

	numberMatchesRange : function ( number, range ) {
		range = range.toString();

		if ( range == '*' ) {
			return true;
		}

		// It's a single number.
		if ( range.match( /^[0-9]+$/ ) ) {
			return ( number == range );
		}

		if ( range.indexOf( ',' ) !== -1 ) {
			let rangeParts = range.split( ',' );

			for ( let i = 0; i < rangeParts.length; i++ ) {
				if ( Cron.numberMatchesRange( number, rangeParts[i] ) ) {
					return true;
				}
			}

			return false;
		}

		if ( range.indexOf( '-' ) !== -1 ) {
			let rangeParts = range.split( '-' );

			let rangeStart = rangeParts[0];
			let rangeEnd = rangeParts[1];

			for ( let i = rangeStart; i <= rangeEnd; i++ ) {
				if ( Cron.numberMatchesRange( number, i ) ) {
					return true;
				}
			}

			return false;
		}

		if ( range.indexOf( '/' ) !== -1 ) {
			// */5 -- every 5 minutes
			// 0-20/2 -- every other hour from midnight to 8pm

			let rangeParts = range.split( '/' );

			if ( Cron.numberMatchesRange( number, rangeParts[0] ) ) {
				if ( number % rangeParts[1] === 0 ) {
					return true;
				}
			}

			return false;
		}

		return false;
	},

	timeMatchesCron : function ( time, cron ) {
		cron = Cron.parse( cron );

		// Does the day of the week match?
		if ( ! Cron.numberMatchesRange( time.getDay(), cron.dayOfWeek ) ) {
			return false;
		}

		// Does the month match?
		if ( ! Cron.numberMatchesRange( time.getMonth(), cron.month ) ) {
			return false;
		}

		// Does the day of the month match?
		if ( ! Cron.numberMatchesRange( time.getDate(), cron.dayOfMonth ) ) {
			return false;
		}

		// Does the hour match?
		if ( ! Cron.numberMatchesRange( time.getHours(), cron.hour ) ) {
			return false;
		}

		// Does the minute match?
		if ( ! Cron.numberMatchesRange( time.getMinutes(), cron.minute ) ) {
			return false;
		}

		return true;
	}
};