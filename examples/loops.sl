; break/continue in every loop kind, and a loop condition that calls a proc.

stage {
  var @evens
  var @steps
  var @found
  var @polls
}

sprite "Sprite1" {
  list @log

  proc @next() warp returns {
    var.change @polls, 1
    %0 = var.get @polls
    ret %0
  }

  script flag {
    repeat 10 {
      var.change @steps, 1
      %0 = var.get @steps
      %1 = mod %0, 2
      %2 = eq %1, 1
      if %2 {
        continue
      }
      var.change @evens, 1
      %3 = gt %0, 7
      if %3 {
        break
      }
      list.add @log, %0
    }

    forever {
      %4 = var.get @found
      %5 = gt %4, 2
      if %5 {
        break
      }
      var.change @found, 1
    }

    until {
      %6 = call @next()
      %7 = gt %6, 4
      cond %7
    } do {
      list.add @log, "poll"
    }
  }
}
