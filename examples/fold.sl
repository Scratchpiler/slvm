; Things constfold may and may not do under Scratch's value semantics.

sprite "Sprite1" {
  var @x
  var @debug internal

  script flag {
    %0 = eq "Apple", "APPLE"
    %1 = mod -1, 3
    %2 = join 1, 2
    %3 = add "abc", 1
    var.set @x, %1
    var.set @x, %2
    var.set @x, %3

    %4 = var.get @x
    %5 = add %4, 0
    var.set @x, %5

    %6 = not %0
    if %6 {
      sb looks_say(MESSAGE: "unreachable")
    } else {
      sb looks_say(MESSAGE: "case-insensitive")
    }

    %7 = var.get @debug
    %8 = random 1, 10
    repeat 0 {
      var.change @x, 1
    }
    until {
      %9 = gt 5, 3
      cond %9
    } do {
      var.change @x, 1
    }
    forever {
      var.change @x, 1
    }
  }
}
