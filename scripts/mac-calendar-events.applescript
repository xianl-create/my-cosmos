-- AppleScript: list Calendar.app events in range (past 30 days, next 365 days)
-- Output: one line per event: summary<TAB>startDate<TAB>endDate<TAB>description<TAB>location (newlines in fields → \n)
set startBound to (current date) - (30 * days)
set endBound to (current date) + (365 * days)
set output to ""
tell application "Calendar"
	repeat with aCal in every calendar
		try
			set theEvents to (every event of aCal whose start date ≥ startBound and start date ≤ endBound)
			repeat with ev in theEvents
				try
					set sum to summary of ev
					set sd to start date of ev
					set ed to end date of ev
					set desc to description of ev
					set loc to location of ev
					if sum is missing value then set sum to "Untitled Event"
					if desc is missing value then set desc to ""
					if loc is missing value then set loc to ""
					set sum to my escape(sum as text)
					set desc to my escape(desc as text)
					set loc to my escape(loc as text)
					set sdStr to my dateToISO(sd)
					set edStr to my dateToISO(ed)
					set output to output & sum & tab & sdStr & tab & edStr & tab & desc & tab & loc & return
				end try
			end repeat
		end try
	end repeat
end tell
return output

on escape(t)
	set t to my replace(t, return, "\\n")
	set t to my replace(t, tab, "\\t")
	return t
end escape

on replace(t, a, b)
	set od to AppleScript's text item delimiters
	set AppleScript's text item delimiters to a
	set parts to text items of t
	set AppleScript's text item delimiters to b
	set t to parts as text
	set AppleScript's text item delimiters to od
	return t
end replace

on dateToISO(d)
	set months to {January, February, March, April, May, June, July, August, September, October, November, December}
	set m to month of d
	set mNum to 1
	repeat with i from 1 to 12
		if item i of months is m then
			set mNum to i
			exit repeat
		end if
	end repeat
	return (year of d as text) & "-" & my pad(mNum) & "-" & my pad(day of d) & "T" & my pad(hours of d) & ":" & my pad(minutes of d) & ":" & my pad(seconds of d)
end dateToISO

on pad(n)
	if n < 10 then
		return "0" & (n as text)
	else
		return n as text
	end if
end pad
