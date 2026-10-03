; `until ... step { }` is a loop latch: it runs after every iteration, including one cut short
; by `continue`, and is skipped by `break`. irgen uses it for the increment of `for`/`pyfor`
; and for the condition re-check of `do ... while`.

stage {
  var @i
  var @odd
  var @flag
  var @rounds
}

sprite "Sprite1" {
  list @log

  script flag {
    var.set @i, 1
    until {
      %0 = var.get @i
      %1 = gt %0, 20
      cond %1
    } do {
      %2 = var.get @i
      %3 = mod %2, 2
      %4 = eq %3, 0
      if %4 {
        continue
      }
      %5 = gt %2, 13
      if %5 {
        break
      }
      var.change @odd, %2
      list.add @log, %2
    } step {
      var.change @i, 1
    }

    var.set @flag, "true"
    until {
      %6 = var.get @flag
      %7 = eq %6, "false"
      cond %7
    } do {
      var.change @rounds, 1
      %8 = var.get @rounds
      %9 = lt %8, 3
      if %9 {
        continue
      }
      list.add @log, "late"
    } step {
      %10 = var.get @rounds
      %11 = lt %10, 5
      var.set @flag, %11
    }
  }
}
