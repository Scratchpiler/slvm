; Two recursive calls feed one `add`. The first result has to survive the second call, which
; recurses into @fib and overwrites any plain temp variable, so spill keeps it on a list
; used as a stack. lower.js's per-call-site `_rv` temps get this wrong.

stage {
  var @result
}

sprite "Sprite1" {
  proc @fib(n) warp returns {
    %0 = arg n
    %1 = lt %0, 2
    if %1 {
      ret %0
    }
    %2 = sub %0, 1
    %3 = call @fib(%2)
    %4 = sub %0, 2
    %5 = call @fib(%4)
    %6 = add %3, %5
    ret %6
  }

  script flag {
    %0 = call @fib(10)
    var.set @result, %0
  }
}
